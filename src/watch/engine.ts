import { createHash } from 'node:crypto';
import { matchesGlob } from 'node:path';
import type {
  AstMatcher,
  WatchContract,
  WatchEngineState,
  WatchInput,
  WatchMatch,
  WatchRule,
} from './types.js';

const MAX_STREAM_CHARS = 16_000;
const MAX_SNAPSHOT_CHARS = 512_000;
const RULE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const VALID_SOURCES = new Set([
  'text',
  'thinking',
  'tool',
  'tool-result',
  'task',
  'lifecycle',
  'signal',
]);

type CompiledRule = WatchRule & { regexes: RegExp[] };

export class WatchEngine {
  private readonly rules: CompiledRule[];
  private readonly buffers = new Map<string, string>();
  private state: WatchEngineState;

  constructor(
    contract: WatchContract,
    private readonly matchAst?: AstMatcher,
    restored?: WatchEngineState
  ) {
    this.rules = compileContract(contract);
    this.state = validEngineState(restored) ? structuredClone(restored) : emptyEngineState();
  }

  resetTurn(): void {
    this.buffers.clear();
  }

  finishTurn(): void {
    this.state.turn++;
    this.buffers.clear();
  }

  exportState(): WatchEngineState {
    return structuredClone(this.state);
  }

  async evaluate(input: WatchInput): Promise<WatchMatch[]> {
    const normalized = normalizeInput(input);
    if (!normalized.content) return [];
    const key = normalized.streamKey ?? `${normalized.source}:${normalized.toolName ?? ''}`;
    const prior = normalized.snapshot ? '' : (this.buffers.get(key) ?? '');
    const content = trimBuffer(
      `${prior}${normalized.content}`,
      normalized.snapshot ? MAX_SNAPSHOT_CHARS : MAX_STREAM_CHARS
    );
    this.buffers.set(key, content);

    const matches: WatchMatch[] = [];
    for (const rule of this.rules) {
      if (!scopeMatches(rule, normalized) || !globMatches(rule, normalized.filePaths)) continue;
      const regexMatched =
        rule.regexes.length === 0 || rule.regexes.every((regex) => testRegex(regex, content));
      if (!regexMatched) continue;
      if (rule.astConditions?.length) {
        if (!normalized.snapshot || !this.matchAst) continue;
        const filePath = normalized.filePaths[0];
        const astMatched = await this.matchAst({
          patterns: rule.astConditions,
          content,
          language: normalized.language,
          filePath,
        });
        if (!astMatched) continue;
      }
      const signature = signatureFor(rule, normalized);
      if (!this.canDeliver(rule, signature)) continue;
      this.state.delivered[signature] = this.state.turn;
      trimDelivered(this.state);
      matches.push({
        ruleId: rule.id,
        message: rule.message,
        severity: rule.severity,
        effect: rule.effect,
        activates: rule.activates === true,
        settledCondition: rule.settledCondition,
        interruptMode: rule.interruptMode ?? 'never',
        source: normalized.source,
        signature,
        filePaths: normalized.filePaths,
        provenance: rule.provenance,
      });
    }
    return matches;
  }

  private canDeliver(rule: WatchRule, signature: string): boolean {
    const deliveredAt = this.state.delivered[signature];
    if (deliveredAt === undefined) return true;
    if (rule.repeat?.mode !== 'after-gap') return false;
    return this.state.turn - deliveredAt >= Math.max(1, rule.repeat.gap ?? 1);
  }
}

export function validateWatchContract(contract: WatchContract): void {
  compileContract(contract);
}

function compileContract(contract: WatchContract): CompiledRule[] {
  if (!contract || contract.schemaVersion !== 1 || !Array.isArray(contract.rules))
    throw new Error('Advisor watch contract must use schemaVersion 1 with a rules array');
  const ids = new Set<string>();
  return contract.rules.map((rule) => {
    if (!RULE_ID.test(rule.id)) throw new Error(`Invalid Advisor watch rule id: ${rule.id}`);
    if (ids.has(rule.id)) throw new Error(`Duplicate Advisor watch rule id: ${rule.id}`);
    ids.add(rule.id);
    if (!rule.message?.trim()) throw new Error(`Advisor watch rule ${rule.id} has no message`);
    if (!['nit', 'concern', 'blocker'].includes(rule.severity))
      throw new Error(`Advisor watch rule ${rule.id} has invalid severity`);
    if (!['remind', 'semantic'].includes(rule.effect))
      throw new Error(`Advisor watch rule ${rule.id} has invalid effect`);
    if (rule.effect === 'remind' && rule.scope?.includes('thinking'))
      throw new Error(`Advisor watch rule ${rule.id} cannot remind from thinking text`);
    if (rule.interruptMode && rule.interruptMode !== 'never')
      throw new Error(`Advisor watch rule ${rule.id} requests an unsupported interrupt mode`);
    if (!rule.conditions?.length && !rule.astConditions?.length)
      throw new Error(`Advisor watch rule ${rule.id} has no condition`);
    for (const scope of rule.scope ?? []) {
      const [source] = scope.split(':', 1);
      if (!VALID_SOURCES.has(source))
        throw new Error(`Advisor watch rule ${rule.id} has invalid scope: ${scope}`);
    }
    if (rule.repeat?.mode === 'after-gap' && (rule.repeat.gap ?? 1) < 1)
      throw new Error(`Advisor watch rule ${rule.id} has invalid repeat gap`);
    return {
      ...structuredClone(rule),
      regexes: (rule.conditions ?? []).map((condition) => compileRegex(condition, rule.id)),
    };
  });
}

function compileRegex(source: string, ruleId: string): RegExp {
  let body = source;
  let flags = 'u';
  const inline = body.match(/^\(\?([ims]+)\)/);
  if (inline) {
    flags += inline[1];
    body = body.slice(inline[0].length);
  }
  try {
    return new RegExp(body, [...new Set(flags)].join(''));
  } catch (error) {
    throw new Error(
      `Advisor watch rule ${ruleId} has invalid regex: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function scopeMatches(rule: WatchRule, input: WatchInput): boolean {
  if (!rule.scope?.length) return true;
  return rule.scope.some((scope) => {
    const separator = scope.indexOf(':');
    if (separator < 0) return input.source === scope;
    return (
      input.source === scope.slice(0, separator) && input.toolName === scope.slice(separator + 1)
    );
  });
}

function globMatches(rule: WatchRule, paths: string[]): boolean {
  if (!rule.globs?.length) return true;
  if (!paths.length) return false;
  return paths.some((filePath) => rule.globs!.some((glob) => matchesGlob(filePath, glob)));
}

function normalizeInput(input: WatchInput): WatchInput & { filePaths: string[] } {
  return {
    ...input,
    content: String(input.content ?? ''),
    filePaths: [...new Set((input.filePaths ?? []).map(normalizePath).filter(Boolean))],
  };
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function trimBuffer(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(-limit);
}

function testRegex(regex: RegExp, value: string): boolean {
  regex.lastIndex = 0;
  return regex.test(value);
}

function signatureFor(rule: WatchRule, input: WatchInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        rule: rule.id,
        source: input.source,
        tool: input.toolName,
        paths: input.filePaths,
      })
    )
    .digest('hex');
}

function emptyEngineState(): WatchEngineState {
  return { turn: 0, delivered: {} };
}

function validEngineState(value: WatchEngineState | undefined): value is WatchEngineState {
  return !!value && Number.isInteger(value.turn) && value.turn >= 0 && !!value.delivered;
}

function trimDelivered(state: WatchEngineState): void {
  const entries = Object.entries(state.delivered);
  if (entries.length <= 512) return;
  entries.sort((a, b) => b[1] - a[1]);
  state.delivered = Object.fromEntries(entries.slice(0, 512));
}
