const DEFAULT_LIMIT = 3_000;
const HOST_LIMIT = 14_000;
const SUMMARY_LIMIT = 18_000;

const DIRECTIVE_LIKE =
  /\b(?:ignore\s+(?:all\s+)?(?:prior|previous|earlier)\s+instructions|system\s+message|developer\s+message|you\s+are\s+now)\b/i;

export type CrossProviderSource = 'user' | 'assistant' | 'tool' | 'summary' | 'host';

export function sanitizeCrossProvider(value: string, source: CrossProviderSource): string {
  let text = redactCrossProviderSecrets(
    value
      .replace(/\r\n?/g, '\n')
      .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
  );
  if (source === 'assistant' || source === 'tool') {
    text = text.replace(
      /<\/?(?:system|developer|user|assistant|primary-transcript)\b[^>]*>/gi,
      '[quarantined role markup]'
    );
    if (DIRECTIVE_LIKE.test(text)) {
      text = `[quarantined directive-like ${source} content]`;
    }
  }
  return bounded(text.trim(), limitFor(source));
}

export function redactCrossProviderSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(
      /\b(authorization|api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^\s"',}]+/gi,
      '$1=[redacted]'
    )
    .replace(/\b(?:sk|dk|ghp|github_pat)-[A-Za-z0-9_-]{8,}\b/g, '[redacted credential]');
}

function limitFor(source: CrossProviderSource): number {
  if (source === 'host') return HOST_LIMIT;
  if (source === 'summary') return SUMMARY_LIMIT;
  return DEFAULT_LIMIT;
}

function bounded(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const head = Math.floor(limit * 0.65);
  return `${value.slice(0, head)}\n… [bounded] …\n${value.slice(-(limit - head - 17))}`;
}
