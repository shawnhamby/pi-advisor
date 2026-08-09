import type { Message } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  buildCompactionSummary,
  extractMessages,
  formatForSupervisor,
} from '../compaction/index.js';
import { sanitizeCrossProvider } from './cross-provider-sanitizer.js';

const MAX_DELTA_CHARS = 14_000;
const MAX_BLOCK_CHARS = 3_000;
const MAX_PRIME_CHARS = 18_000;

export class TranscriptDeltaRecorder {
  private cursor = 0;

  reset(): void {
    this.cursor = 0;
  }

  prime(ctx: ExtensionContext): string | undefined {
    const messages = extractMessages(ctx);
    this.cursor = messages.length;
    if (!messages.length) return undefined;
    const summary = sanitizeCrossProvider(
      formatForSupervisor(buildCompactionSummary(messages)),
      'summary'
    );
    return bounded(summary, MAX_PRIME_CHARS);
  }

  take(ctx: ExtensionContext): string | undefined {
    const messages = extractMessages(ctx);
    if (messages.length < this.cursor) this.cursor = 0;
    const fresh = messages.slice(this.cursor);
    this.cursor = messages.length;
    if (!fresh.length) return undefined;
    const rendered = fresh.map(renderMessage).filter(Boolean).join('\n\n');
    return rendered ? bounded(rendered, MAX_DELTA_CHARS) : undefined;
  }
}

function renderMessage(message: Message): string {
  try {
    if (message.role === 'user') {
      return `<primary-transcript role="user">\n${sanitizeCrossProvider(textContent(message), 'user')}\n</primary-transcript>`;
    }
    if (message.role === 'assistant') {
      const parts = Array.isArray(message.content) ? message.content : [];
      const body = parts
        .map((part) => {
          if (part.type === 'text') return sanitizeCrossProvider(part.text, 'assistant');
          if (part.type === 'thinking')
            return `[reasoning summary] ${sanitizeCrossProvider(part.thinking, 'assistant')}`;
          if (part.type === 'toolCall')
            return `[tool call ${part.name}] ${sanitizeCrossProvider(safeJson(part.arguments), 'tool')}`;
          return '';
        })
        .filter(Boolean)
        .join('\n');
      return `<primary-transcript role="assistant">\n${bounded(body, MAX_BLOCK_CHARS)}\n</primary-transcript>`;
    }
    if (message.role === 'toolResult') {
      const body = sanitizeCrossProvider(textContent(message), 'tool');
      return `<primary-transcript role="tool" name="${xmlAttribute(message.toolName)}" error="${message.isError}">\n${bounded(body, MAX_BLOCK_CHARS)}\n</primary-transcript>`;
    }
    return '';
  } catch {
    return '<primary-transcript quarantined="malformed" />';
  }
}

function textContent(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[quarantined malformed tool input]';
  }
}

function bounded(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const head = Math.floor(limit * 0.65);
  return `${value.slice(0, head)}\n… [bounded] …\n${value.slice(-(limit - head - 17))}`;
}

function xmlAttribute(value: string): string {
  return value.replace(/[&"<>]/g, (character) => {
    if (character === '&') return '&amp;';
    if (character === '"') return '&quot;';
    if (character === '<') return '&lt;';
    return '&gt;';
  });
}
