export type BackgroundBatch<T> = {
  items: T[];
  generation: number;
};

type CatchupWaiter = {
  finish(caughtUp: boolean): void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * One nonblocking, coalescing background lane plus a bounded foreground gate.
 * Background failures are intentionally swallowed; completion and direct
 * questions use runForeground so they never overlap the isolated model session.
 */
export class IncrementalAdvisorQueue<T> {
  private pending: T[] = [];
  private busy = false;
  private foreground = false;
  private foregroundTail: Promise<void> = Promise.resolve();
  private generation = 0;
  private waiters = new Set<CatchupWaiter>();

  constructor(
    private readonly process: (batch: BackgroundBatch<T>) => Promise<void>,
    private readonly onBackgroundError?: (error: unknown) => void
  ) {}

  enqueue(item: T): void {
    this.pending.push(item);
    void this.drain();
  }

  reset(): number {
    this.generation++;
    this.pending = [];
    this.finishWaiters(false);
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  async waitForCatchup(maxMs: number, signal?: AbortSignal): Promise<boolean> {
    if (!this.busy && this.pending.length === 0) return true;
    if (signal?.aborted) return false;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (caughtUp: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        signal?.removeEventListener('abort', abort);
        resolve(caughtUp);
      };
      const abort = (): void => finish(false);
      const waiter: CatchupWaiter = {
        finish,
        timer: setTimeout(abort, maxMs),
      };
      this.waiters.add(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  async runForeground<R>(
    work: () => Promise<R>,
    maxCatchupMs: number,
    signal?: AbortSignal
  ): Promise<R> {
    const startedAt = Date.now();
    const previous = this.foregroundTail;
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.foregroundTail = previous.then(() => slot);
    if (!(await settleBefore(previous, maxCatchupMs, signal))) {
      release();
      throw new Error(`Advisor catch-up exceeded ${Math.round(maxCatchupMs / 1000)} seconds`);
    }
    const remaining = Math.max(0, maxCatchupMs - (Date.now() - startedAt));
    if (!(await this.waitForCatchup(remaining, signal))) {
      release();
      throw new Error(`Advisor catch-up exceeded ${Math.round(maxCatchupMs / 1000)} seconds`);
    }
    this.foreground = true;
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
      this.foreground = false;
      release();
      this.notifyCaughtUp();
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    if (this.busy || this.foreground || this.pending.length === 0) return;
    this.busy = true;
    try {
      while (!this.foreground && this.pending.length > 0) {
        const batch = { items: this.pending.splice(0), generation: this.generation };
        try {
          await this.process(batch);
        } catch (error) {
          this.onBackgroundError?.(error);
        }
      }
    } finally {
      this.busy = false;
      this.notifyCaughtUp();
      if (!this.foreground && this.pending.length > 0) void this.drain();
    }
  }

  private notifyCaughtUp(): void {
    if (this.busy || this.pending.length > 0) return;
    this.finishWaiters(true);
  }

  private finishWaiters(caughtUp: boolean): void {
    for (const waiter of [...this.waiters]) waiter.finish(caughtUp);
  }
}

function settleBefore(
  promise: Promise<void>,
  maxMs: number,
  signal?: AbortSignal
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = (): void => finish(false);
    const timer = setTimeout(abort, maxMs);
    signal?.addEventListener('abort', abort, { once: true });
    void promise.then(
      () => finish(true),
      () => finish(true)
    );
  });
}
