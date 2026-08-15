export class CompletionAnalysisTimeoutError extends Error {
  constructor() {
    super('completion analysis timed out');
    this.name = 'CompletionAnalysisTimeoutError';
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
