import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { CompletionReconciliationEntry } from '../core/completion-control.js';
import type { AdvisorState, CompletionRejectKind, PlanBinding, ToolEvidence } from '../types.js';
import type { WatchEngineState, WatchMatch } from '../watch/types.js';
import { normalizeAdvisorNote } from '../core/emission-guard.js';

const ADVISOR_STATE_ENTRY = 'pi-advisor-state';
const MAX_TOOL_EVIDENCE = 40;
const MAX_TRUSTED_INPUTS = 16;

export class AdvisorStateManager {
  private state: AdvisorState = emptyState();

  constructor(private readonly pi: ExtensionAPI) {}

  get(): AdvisorState {
    return this.state;
  }

  load(ctx: ExtensionContext): void {
    const entry = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find(
        (candidate) => candidate.type === 'custom' && candidate.customType === ADVISOR_STATE_ENTRY
      );
    this.state =
      entry?.type === 'custom' && validState(entry.data)
        ? structuredClone(entry.data)
        : emptyState();
    this.state.trustedInputs ??= [];
    this.state.pendingSemanticMatches ??= [];
    this.state.activeTools = {};
    normalizeCompletionReconciliations(this.state);
  }

  persist(): void {
    this.pi.appendEntry(ADVISOR_STATE_ENTRY, structuredClone(this.state));
  }

  bindTrustedInput(
    text: string,
    source: 'interactive' | 'rpc',
    at = Date.now(),
    allowInitialObjective = true
  ): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const priorAt = this.state.trustedInputs.at(-1)?.at ?? 0;
    const effectiveAt = Math.max(at, priorAt + 1);
    this.state.lastTrustedInput = { text: trimmed, source, at: effectiveAt };
    this.state.trustedInputs.push({ text: trimmed, source, at: effectiveAt });
    this.state.continuationIssuedFor = undefined;
    this.state.completionReconciliations = undefined;
    this.state.pendingSemanticMatches = [];
    if (this.state.trustedInputs.length > MAX_TRUSTED_INPUTS) {
      this.state.trustedInputs.splice(0, this.state.trustedInputs.length - MAX_TRUSTED_INPUTS);
    }
    if (!this.state.objective && allowInitialObjective) {
      this.state.objective = trimmed;
      this.state.objectiveUpdatedAt = effectiveAt;
    }
  }

  applyObjectiveInput(at: number): boolean {
    const input = this.state.trustedInputs.find((candidate) => candidate.at === at);
    if (!input) return false;
    this.state.objective = input.text;
    this.state.objectiveUpdatedAt = input.at;
    this.persist();
    return true;
  }

  setPlan(plan: PlanBinding | undefined): void {
    this.state.plan = plan;
  }

  setInstructions(instructions: AdvisorState['instructions']): void {
    this.state.instructions = instructions;
  }

  setTaskState(value: unknown, reason?: string): void {
    this.state.taskState = structuredClone(value);
    this.state.taskReason = reason;
    this.dropClosedCompletionReconciliations();
  }

  completionReconciliations(): Record<string, CompletionReconciliationEntry> {
    return { ...(this.state.completionReconciliations ?? {}) };
  }

  setCompletionReconciliation(taskId: string, reason: string, kind: CompletionRejectKind): void {
    const trimmed = reason.trim();
    const prior = this.state.completionReconciliations?.[taskId];
    const sameReason =
      prior?.kind === kind && normalizeAdvisorNote(prior.reason) === normalizeAdvisorNote(trimmed);
    this.state.completionReconciliations = {
      ...this.state.completionReconciliations,
      [taskId]: {
        reason: trimmed,
        kind,
        nudged: sameReason ? prior.nudged : false,
      },
    };
  }

  markCompletionReconciliationNudged(taskId: string): boolean {
    const reconciliation = this.state.completionReconciliations?.[taskId];
    if (!reconciliation || reconciliation.nudged) return false;
    reconciliation.nudged = true;
    return true;
  }

  clearCompletionReconciliation(taskId: string): void {
    const current = this.state.completionReconciliations;
    if (!current?.[taskId]) return;
    const next = { ...current };
    delete next[taskId];
    this.state.completionReconciliations = Object.keys(next).length ? next : undefined;
  }

  dropClosedCompletionReconciliations(): void {
    const current = this.state.completionReconciliations;
    if (!current) return;
    const records = taskRecords(this.state.taskState) ?? {};
    const next: Record<string, CompletionReconciliationEntry> = {};
    for (const [taskId, entry] of Object.entries(current)) {
      const task = records[taskId];
      const status =
        task &&
        typeof task === 'object' &&
        typeof (task as { status?: unknown }).status === 'string'
          ? (task as { status: string }).status
          : undefined;
      if (!task || status === 'completed' || status === 'deleted' || status === 'done') continue;
      next[taskId] = entry;
    }
    this.state.completionReconciliations = Object.keys(next).length ? next : undefined;
  }

  setWatchState(value: WatchEngineState): void {
    this.state.watch = structuredClone(value);
  }

  queueSemanticMatches(matches: WatchMatch[]): void {
    this.state.pendingSemanticMatches ??= [];
    const existing = new Set(this.state.pendingSemanticMatches.map((match) => match.signature));
    for (const match of matches) {
      if (existing.has(match.signature)) continue;
      this.state.pendingSemanticMatches.push(structuredClone(match));
      existing.add(match.signature);
    }
    if (this.state.pendingSemanticMatches.length > 12)
      this.state.pendingSemanticMatches.splice(0, this.state.pendingSemanticMatches.length - 12);
  }

  semanticMatches(): WatchMatch[] {
    return structuredClone(this.state.pendingSemanticMatches ?? []);
  }

  clearSemanticMatches(): void {
    this.state.pendingSemanticMatches = [];
  }

  toolStarted(id: string, name: string, input: Record<string, unknown>): void {
    this.state.activeTools[id] = { name, startedAt: Date.now() };
    if (isMutationTool(name)) {
      for (const file of extractPaths(input)) this.addTouchedFile(file);
    }
  }

  toolFinished(evidence: ToolEvidence): void {
    delete this.state.activeTools[evidence.toolCallId];
    this.state.toolEvidence.push(evidence);
    if (this.state.toolEvidence.length > MAX_TOOL_EVIDENCE)
      this.state.toolEvidence.splice(0, this.state.toolEvidence.length - MAX_TOOL_EVIDENCE);
    if (isValidationTool(evidence)) this.state.validationAt = evidence.finishedAt;
    if (evidence.isError) this.addBlocker(`${evidence.toolName}: ${evidence.outputPreview}`);
    else
      this.state.blockers = this.state.blockers.filter(
        (item) => !item.startsWith(`${evidence.toolName}:`)
      );
  }

  addTouchedFile(file: string): void {
    if (!file || this.state.touchedFiles.includes(file)) return;
    this.state.touchedFiles.push(file);
    this.state.touchedFiles.sort();
  }

  addBlocker(blocker: string): void {
    const trimmed = blocker.trim();
    if (trimmed && !this.state.blockers.includes(trimmed)) this.state.blockers.push(trimmed);
  }

  markAnalyzed(): void {
    this.state.lastAnalysisAt = Date.now();
  }

  emissionAllowed(signature: string, minimumIntervalMs = 30_000): boolean {
    const now = Date.now();
    if (
      this.state.lastEmissionSignature === signature &&
      now - (this.state.lastEmissionAt ?? 0) < minimumIntervalMs
    )
      return false;
    this.state.lastEmissionSignature = signature;
    this.state.lastEmissionAt = now;
    return true;
  }

  markContinuation(signature: string): boolean {
    if (this.state.continuationIssuedFor) return false;
    this.state.continuationIssuedFor = signature;
    this.persist();
    return true;
  }

  markContinuityPending(): void {
    this.state.pendingContinuity = true;
    this.persist();
  }

  takeContinuityReminder(): string | undefined {
    if (!this.state.pendingContinuity) return undefined;
    this.state.pendingContinuity = false;
    this.persist();
    const task = activeTask(this.state.taskState);
    const classes = [
      this.state.objective ? 'objective' : undefined,
      this.state.plan ? 'plan' : undefined,
      task ? 'task' : undefined,
      this.state.blockers.length ? 'blockers' : undefined,
      this.state.touchedFiles.length ? 'changed files' : undefined,
      this.state.instructions.length ? 'instructions' : undefined,
      Object.keys(this.state.activeTools).length ? 'live work' : undefined,
    ].filter(Boolean);
    return `Execution continuity restored after compaction: ${classes.join(', ') || 'no active references'}. Continue from the bound objective and current task evidence; do not treat compaction as completion or a new user instruction.`;
  }
}

export function activeTask(value: unknown): { id: string; task: any } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const event = value as any;
  const state = event.state ?? event;
  const id = state?.activeTaskId;
  const tasks = state?.tasks;
  const task = id
    ? Array.isArray(tasks)
      ? tasks.find((candidate: any) => candidate?.id === id)
      : tasks?.[id]
    : undefined;
  return task ? { id, task } : undefined;
}

function normalizeCompletionReconciliations(state: AdvisorState): void {
  const next: Record<string, CompletionReconciliationEntry> = {
    ...(state.completionReconciliations ?? {}),
  };
  const legacy = (
    state as AdvisorState & {
      completionReconciliation?: { taskId?: string; reason?: string; nudged?: boolean };
    }
  ).completionReconciliation;
  if (
    legacy &&
    typeof legacy.taskId === 'string' &&
    legacy.taskId &&
    typeof legacy.reason === 'string'
  ) {
    next[legacy.taskId] ??= {
      reason: legacy.reason,
      kind: 'unavailable',
      nudged: Boolean(legacy.nudged),
    };
  }
  for (const [taskId, entry] of Object.entries(next)) {
    if (!entry || typeof entry.reason !== 'string') {
      delete next[taskId];
      continue;
    }
    next[taskId] = {
      reason: entry.reason,
      kind: validRejectKind(entry.kind) ? entry.kind : 'unavailable',
      nudged: Boolean(entry.nudged),
    };
  }
  state.completionReconciliations = Object.keys(next).length ? next : undefined;
  delete (state as { completionReconciliation?: unknown }).completionReconciliation;
}

function validRejectKind(value: unknown): value is CompletionRejectKind {
  return (
    value === 'missing-evidence' ||
    value === 'gap' ||
    value === 'blocked' ||
    value === 'active-tools' ||
    value === 'unavailable'
  );
}

function taskRecords(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const event = value as { state?: unknown; tasks?: unknown };
  const state = event.state ?? event;
  if (!state || typeof state !== 'object') return undefined;
  const tasks = (state as { tasks?: unknown }).tasks;
  if (Array.isArray(tasks)) {
    return Object.fromEntries(
      tasks
        .filter((task): task is Record<string, unknown> => !!task && typeof task === 'object')
        .filter((task) => typeof task.id === 'string')
        .map((task) => [String(task.id), task])
    );
  }
  return tasks && typeof tasks === 'object' ? (tasks as Record<string, unknown>) : undefined;
}

function emptyState(): AdvisorState {
  return {
    version: 1,
    instructions: [],
    touchedFiles: [],
    blockers: [],
    toolEvidence: [],
    activeTools: {},
    trustedInputs: [],
  };
}

function validState(value: unknown): value is AdvisorState {
  return !!value && typeof value === 'object' && (value as AdvisorState).version === 1;
}

function extractPaths(input: Record<string, unknown>): string[] {
  const values = [input.path, input.file, input.filePath, input.file_path, input.target].filter(
    (value): value is string => typeof value === 'string'
  );
  return [...new Set(values)];
}

function isValidationTool(evidence: ToolEvidence): boolean {
  return !evidence.isError && evidence.validation === true;
}

function isMutationTool(name: string): boolean {
  return /(?:edit|write|patch|delete|create|rename|move)/i.test(name);
}
