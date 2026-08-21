import type {
  AdvisorDecision,
  AdvisorSeverity,
  AdvisorState,
  CompletionRejectKind,
} from '../types.js';

export class CompletionAnalysisTimeoutError extends Error {
  constructor() {
    super('completion analysis timed out');
    this.name = 'CompletionAnalysisTimeoutError';
  }
}

export const COMPLETION_ANALYSIS_TIMEOUT_MS = 120_000;

export async function withCompletionAnalysisTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectCancellation: ((error: Error) => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const abort = (): void => {
    controller.abort();
    rejectCancellation?.(new Error('completion analysis aborted'));
  };

  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(() => {
    controller.abort();
    rejectCancellation?.(new CompletionAnalysisTimeoutError());
  }, timeoutMs);

  try {
    return await Promise.race([work(controller.signal), cancellation]);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export function reconcileActiveTools<T>(
  activeTools: Record<string, T>,
  liveToolCallIds: Iterable<string>
): string[] {
  const live = new Set(liveToolCallIds);
  for (const toolCallId of Object.keys(activeTools)) {
    if (!live.has(toolCallId)) delete activeTools[toolCallId];
  }
  return Object.keys(activeTools);
}

export const ABANDON_UNVERIFIED_TASK_EVENT = 'pi-advisor:abandon-unverified-task';

export type { CompletionRejectKind };

export type CompletionReconciliationEntry = {
  reason: string;
  kind: CompletionRejectKind;
  nudged: boolean;
};

export type SettledCompletionActions = {
  abandon: Array<CompletionReconciliationEntry & { taskId: string }>;
  nudge: Array<CompletionReconciliationEntry & { taskId: string }>;
  drop: string[];
};

const CLOSED_TASK_STATUSES = new Set(['completed', 'deleted', 'done']);

export function completionCorrection(taskId: string, detail?: string, abandonHint = false): string {
  const base = `Task #${taskId} remains active because Advisor could not verify completion${detail ? `: ${detail}` : '.'} Continue the work or add concrete evidence, then retry TaskUpdate.`;
  if (!abandonHint) return base;
  return `${base} If you cannot produce evidence, TaskUpdate status=deleted so the task does not remain open.`;
}

export function planSettledCompletionActions(args: {
  reconciliations: Record<string, CompletionReconciliationEntry>;
  tasks: Record<string, Record<string, unknown> | undefined>;
}): SettledCompletionActions {
  const abandon: SettledCompletionActions['abandon'] = [];
  const nudge: SettledCompletionActions['nudge'] = [];
  const drop: string[] = [];
  for (const [taskId, recon] of Object.entries(args.reconciliations)) {
    const task = args.tasks[taskId];
    const status = typeof task?.status === 'string' ? task.status : undefined;
    if (!task || CLOSED_TASK_STATUSES.has(status ?? '')) {
      drop.push(taskId);
      continue;
    }
    const entry = { taskId, ...recon };
    if (recon.kind === 'missing-evidence') {
      abandon.push(entry);
      continue;
    }
    if (!recon.nudged) nudge.push(entry);
  }
  return { abandon, nudge, drop };
}

export type CompletionEmission = {
  message: string;
  severity: AdvisorSeverity;
  deliverAs: 'followUp';
  triggerTurn: boolean;
};

export function completionEmission(taskId: string, decision: AdvisorDecision): CompletionEmission {
  if (decision.verdict === 'PASS' && decision.confidence >= 0.7) {
    return {
      message: `Task #${taskId} completion verification passed. Retry TaskUpdate status=completed now.`,
      severity: 'nit',
      deliverAs: 'followUp',
      triggerTurn: true,
    };
  }
  if (decision.verdict === 'GAP') {
    const reason = decision.message?.trim() || decision.reasoning.trim();
    return {
      message: `Task #${taskId} completion verification found a remaining gap: ${reason} Continue from that gap, then retry TaskUpdate.`,
      severity: 'concern',
      deliverAs: 'followUp',
      triggerTurn: true,
    };
  }
  return {
    message: `Task #${taskId} completion verification did not converge; the task remains active.`,
    severity: 'concern',
    deliverAs: 'followUp',
    triggerTurn: false,
  };
}

export function hasTaskLocalCompletionEvidence(task: Record<string, unknown>): boolean {
  const metadata = task.metadata;
  if (!metadata || typeof metadata !== 'object') return false;
  const evidence = (metadata as { evidence?: unknown }).evidence;
  const entries = Array.isArray(evidence) ? evidence : evidence ? [evidence] : [];
  return entries.some((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    const entry = candidate as Record<string, unknown>;
    const observed = hasText(entry.observed) || hasText(entry.observed_text);
    const anchored = hasText(entry.line_hash) || hasText(entry.file_hash);
    return hasText(entry.source) && (observed || anchored);
  });
}

export function hasCompletionEvidence(
  task: Record<string, unknown>,
  state: Pick<AdvisorState, 'toolEvidence'>
): boolean {
  if (hasTaskLocalCompletionEvidence(task)) return true;
  const createdAt = typeof task.createdAt === 'number' ? task.createdAt : 0;
  return state.toolEvidence.some(
    (evidence) =>
      evidence.validation === true &&
      !evidence.isError &&
      evidence.finishedAt >= createdAt &&
      hasText(evidence.outputDigest) &&
      hasText(evidence.outputPreview)
  );
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
