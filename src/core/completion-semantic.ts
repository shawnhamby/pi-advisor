import { createHash } from 'node:crypto';
import type { AdvisorDecision, AdvisorState } from '../types.js';

export type CompletionRuntimeSnapshot = {
  cwd: string;
  modelProvider?: string;
  modelId?: string;
  systemPromptDigest: string;
};

export type CompletionCacheResult =
  | { kind: 'pass' }
  | { kind: 'gap'; decision: AdvisorDecision }
  | { kind: 'cooldown'; decision: AdvisorDecision }
  | { kind: 'pending'; started: boolean };

type RunningEntry = {
  kind: 'running';
  generation: number;
  controller: AbortController;
};

type SettledEntry = {
  kind: 'pass' | 'gap' | 'cooldown';
  generation: number;
  decision: AdvisorDecision;
  settledAt: number;
};

type CompletionEntry = RunningEntry | SettledEntry;

export class CompletionSemanticCache {
  private generation = 0;
  private readonly entries = new Map<string, CompletionEntry>();
  private running: { signature: string; entry: RunningEntry } | undefined;

  constructor(
    private readonly passTtlMs = COMPLETION_PASS_TTL_MS,
    private readonly now: () => number = Date.now,
    private readonly cooldownMs = COMPLETION_UNKNOWN_COOLDOWN_MS
  ) {}

  request(
    signature: string,
    run: (signal: AbortSignal) => Promise<AdvisorDecision>,
    stillCurrent: () => boolean,
    onSettled: (decision: AdvisorDecision) => void
  ): CompletionCacheResult {
    let existing = this.entries.get(signature);
    if (existing?.kind === 'pass' || existing?.kind === 'cooldown') {
      const ttl = existing.kind === 'pass' ? this.passTtlMs : this.cooldownMs;
      if (this.now() - existing.settledAt > ttl) {
        this.entries.delete(signature);
        existing = undefined;
      } else {
        if (existing.kind === 'pass') {
          this.entries.delete(signature);
          return { kind: 'pass' };
        }
        return { kind: 'cooldown', decision: existing.decision };
      }
    }
    if (existing?.kind === 'gap') return { kind: 'gap', decision: existing.decision };
    if (this.running?.signature === signature) return { kind: 'pending', started: false };
    if (this.running) {
      this.running.entry.controller.abort();
      this.entries.delete(this.running.signature);
      this.running = undefined;
    }

    const generation = this.generation;
    const controller = new AbortController();
    const entry: RunningEntry = { kind: 'running', generation, controller };
    this.entries.set(signature, entry);
    this.running = { signature, entry };
    void run(controller.signal).then(
      (decision) => {
        if (!this.isCurrent(signature, entry)) return;
        this.running = undefined;
        if (!stillCurrent()) {
          this.entries.delete(signature);
          return;
        }
        if (decision.verdict === 'PASS' && decision.confidence >= 0.7) {
          this.entries.set(signature, {
            kind: 'pass',
            generation,
            decision,
            settledAt: this.now(),
          });
        } else if (decision.verdict === 'GAP') {
          this.entries.set(signature, {
            kind: 'gap',
            generation,
            decision,
            settledAt: this.now(),
          });
        } else {
          this.entries.set(signature, {
            kind: 'cooldown',
            generation,
            decision,
            settledAt: this.now(),
          });
        }
        onSettled(decision);
      },
      () => {
        if (!this.isCurrent(signature, entry)) return;
        this.running = undefined;
        this.entries.delete(signature);
      }
    );
    return { kind: 'pending', started: true };
  }

  invalidate(): void {
    this.generation++;
    this.running?.entry.controller.abort();
    this.running = undefined;
    this.entries.clear();
  }

  invalidateForTool(toolName: string, input: Record<string, unknown> = {}, isError = false): void {
    if (!isError && isCompletionObservationTool(toolName, input)) return;
    this.invalidate();
  }

  private isCurrent(signature: string, entry: RunningEntry): boolean {
    return this.generation === entry.generation && this.entries.get(signature) === entry;
  }
}

export const COMPLETION_PASS_TTL_MS = 60_000;
export const COMPLETION_UNKNOWN_COOLDOWN_MS = 60_000;

/**
 * Successful observation tools do not change the completion facts captured at
 * the gate. Unknown and mixed tools fail closed unless their action is a
 * proven read-only operation.
 */
export function isCompletionObservationTool(
  toolName: string,
  input: Record<string, unknown> = {}
): boolean {
  const name = toolName.toLowerCase();
  if (COMPLETION_OBSERVATION_TOOLS.has(name)) return true;
  const action = typeof input.action === 'string' ? input.action.toLowerCase() : '';
  return COMPLETION_OBSERVATION_ACTIONS[name]?.has(action) ?? false;
}

const COMPLETION_OBSERVATION_TOOLS = new Set([
  'read',
  'digest',
  'grep',
  'find',
  'ls',
  'list',
  'readseek_digest',
  'readseek_grep',
  'readseek_search',
  'readseek_view',
  'readseek_def',
  'readseek_refs',
  'lsp_diagnostics',
  'lsp_diagnostics_many',
  'lsp_find_symbol',
  'lsp_hover',
  'lsp_definition',
  'lsp_references',
  'lsp_implementation',
  'lsp_document_symbols',
  'lsp_preview_rename',
  'taskget',
  'tasklist',
  'subagent_wait',
  'subagent_status',
  'wait_agent',
  'list_agents',
  'agent_list',
  'agent_status',
  'view_image',
]);

const COMPLETION_OBSERVATION_ACTIONS: Record<string, ReadonlySet<string>> = {
  subagent: new Set(['status']),
  herdr_layout: new Set(['current', 'workspace_list', 'tab_list', 'pane_list', 'pane_layout']),
  herdr_pane: new Set(['get', 'read', 'wait_output']),
  herdr_agent: new Set(['list', 'get', 'wait', 'read']),
};

export function completionSignature(
  taskId: string,
  task: Record<string, unknown>,
  state: AdvisorState,
  runtime: CompletionRuntimeSnapshot
): string {
  return digest(
    stableStringify({
      taskId,
      task,
      runtime,
      objective: state.objective,
      objectiveUpdatedAt: state.objectiveUpdatedAt,
      plan: state.plan,
      instructions: state.instructions,
      touchedFiles: state.touchedFiles,
      validationAt: state.validationAt,
      blockers: state.blockers,
      lastTrustedInput: state.lastTrustedInput,
    })
  );
}

export function runtimeSnapshot(
  cwd: string,
  model: unknown,
  systemPrompt: string
): CompletionRuntimeSnapshot {
  const selected = model && typeof model === 'object' ? (model as Record<string, unknown>) : {};
  return {
    cwd,
    modelProvider: text(selected.provider),
    modelId: text(selected.id) ?? text(selected.modelId),
    systemPromptDigest: digest(systemPrompt),
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, candidate]) => candidate !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, candidate]) => [key, sortValue(candidate)])
  );
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
