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
  | { kind: 'pending'; started: boolean };

type RunningEntry = {
  kind: 'running';
  generation: number;
  controller: AbortController;
};

type SettledEntry = {
  kind: 'pass' | 'gap';
  generation: number;
  decision: AdvisorDecision;
  settledAt: number;
};

type CompletionEntry = RunningEntry | SettledEntry;

export class CompletionSemanticCache {
  private generation = 0;
  private readonly entries = new Map<string, CompletionEntry>();

  constructor(
    private readonly passTtlMs = COMPLETION_PASS_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  request(
    signature: string,
    run: (signal: AbortSignal) => Promise<AdvisorDecision>,
    stillCurrent: () => boolean,
    onSettled: (decision: AdvisorDecision) => void
  ): CompletionCacheResult {
    const existing = this.entries.get(signature);
    if (existing?.kind === 'pass') {
      if (this.now() - existing.settledAt > this.passTtlMs) {
        this.entries.delete(signature);
      } else {
        this.entries.delete(signature);
        return { kind: 'pass' };
      }
    }
    const current = this.entries.get(signature);
    if (current?.kind === 'gap') return { kind: 'gap', decision: current.decision };
    if (current?.kind === 'running') return { kind: 'pending', started: false };

    const generation = this.generation;
    const controller = new AbortController();
    const entry: RunningEntry = { kind: 'running', generation, controller };
    this.entries.set(signature, entry);
    void run(controller.signal).then(
      (decision) => {
        if (!this.isCurrent(signature, entry)) return;
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
          this.entries.delete(signature);
        }
        onSettled(decision);
      },
      () => {
        if (this.isCurrent(signature, entry)) this.entries.delete(signature);
      }
    );
    return { kind: 'pending', started: true };
  }

  invalidate(): void {
    this.generation++;
    for (const entry of this.entries.values()) {
      if (entry.kind === 'running') entry.controller.abort();
    }
    this.entries.clear();
  }

  private isCurrent(signature: string, entry: RunningEntry): boolean {
    return this.generation === entry.generation && this.entries.get(signature) === entry;
  }
}

export const COMPLETION_PASS_TTL_MS = 60_000;

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
      toolEvidence: state.toolEvidence,
      activeTools: state.activeTools,
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
