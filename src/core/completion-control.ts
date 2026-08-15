export class CompletionAnalysisTimeoutError extends Error {
  constructor() {
    super('completion analysis timed out');
    this.name = 'CompletionAnalysisTimeoutError';
  }
}

export const COMPLETION_CATCHUP_MS = 3_000;
// The completion gate launches this budget without awaiting it: a short queue
// catchup phase is followed by an independent medium-model decision window.
export const COMPLETION_ANALYSIS_TIMEOUT_MS = 60_000;

export async function withCompletionForegroundLease<T>(
  acquire: (signal: AbortSignal, catchupMs: number) => Promise<() => void>,
  work: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  budgets: { catchupMs: number; timeoutMs: number } = {
    catchupMs: COMPLETION_CATCHUP_MS,
    timeoutMs: COMPLETION_ANALYSIS_TIMEOUT_MS,
  }
): Promise<T> {
  const release = await withCompletionAnalysisTimeout(
    (catchupSignal) => acquire(catchupSignal, budgets.catchupMs),
    budgets.catchupMs,
    signal
  );
  try {
    return await withCompletionAnalysisTimeout(work, budgets.timeoutMs, signal);
  } finally {
    release();
  }
}

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

export function completionCorrection(taskId: string, detail?: string): string {
  return `Task #${taskId} remains active because Advisor could not verify completion${detail ? `: ${detail}` : '.'} Continue the work or add concrete evidence, then retry TaskUpdate.`;
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

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
