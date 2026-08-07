import { createHash } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AdvisorState, PlanBinding, ToolEvidence } from '../types.js';

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
    this.state.activeTools = {};
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
    this.state.completionPermit = undefined;
    this.state.continuationIssuedFor = undefined;
    this.persist();
    return true;
  }

  setPlan(plan: PlanBinding | undefined): void {
    if (JSON.stringify(this.state.plan) !== JSON.stringify(plan)) {
      this.state.completionPermit = undefined;
    }
    this.state.plan = plan;
  }

  setInstructions(instructions: AdvisorState['instructions']): void {
    this.state.instructions = instructions;
  }

  setTaskState(value: unknown, reason?: string): void {
    this.state.taskState = structuredClone(value);
    this.state.taskReason = reason;
    this.state.completionPermit = undefined;
  }

  toolStarted(id: string, name: string, input: Record<string, unknown>): void {
    this.state.activeTools[id] = { name, startedAt: Date.now() };
    if (isMutationTool(name)) {
      for (const file of extractPaths(input)) this.addTouchedFile(file);
    }
    if (isMutationTool(name) || isShellTool(name)) this.state.completionPermit = undefined;
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

  issuePermit(taskId: string): string {
    const digest = stateDigest(this.state, taskId);
    this.state.completionPermit = { digest, taskId, createdAt: Date.now() };
    this.persist();
    return digest;
  }

  consumePermit(taskId: string): boolean {
    const permit = this.state.completionPermit;
    if (!permit || permit.taskId !== taskId || permit.digest !== stateDigest(this.state, taskId))
      return false;
    this.state.completionPermit = undefined;
    this.persist();
    return true;
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
    if (this.state.continuationIssuedFor === signature) return false;
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

function stateDigest(state: AdvisorState, taskId: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        objective: state.objective,
        plan: state.plan,
        taskId,
        task: activeTask(state.taskState),
        touchedFiles: state.touchedFiles,
        validationAt: state.validationAt,
        blockers: state.blockers,
        lastTrustedInput: state.lastTrustedInput,
        evidence: state.toolEvidence
          .filter(
            (item) =>
              item.isError ||
              isValidationTool(item) ||
              isMutationTool(item.toolName) ||
              isShellTool(item.toolName)
          )
          .map(({ toolCallId, outputDigest, isError }) => ({
            toolCallId,
            outputDigest,
            isError,
          })),
      })
    )
    .digest('hex');
}

export function activeTask(value: unknown): { id: string; task: any } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const state = (value as any).state;
  const id = state?.activeTaskId;
  const task = id ? state?.tasks?.[id] : undefined;
  return task ? { id, task } : undefined;
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
  if (evidence.isError) return false;
  const text = `${evidence.toolName} ${JSON.stringify(evidence.input)}`.toLowerCase();
  return /(?:test|check|lint|typecheck|verify|diagnostic|build)/.test(text);
}

function isMutationTool(name: string): boolean {
  return /(?:edit|write|patch|delete|create|rename|move)/i.test(name);
}

function isShellTool(name: string): boolean {
  return /^(?:bash|shell|exec|exec_command)$/i.test(name);
}
