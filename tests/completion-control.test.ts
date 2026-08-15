import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CompletionAnalysisTimeoutError,
  completionCorrection,
  hasTaskLocalCompletionEvidence,
  reconcileActiveTools,
  withCompletionForegroundLease,
  withCompletionAnalysisTimeout,
} from '../src/core/completion-control.ts';

test(
  'completion analysis returns within its bound and aborts the model call',
  { timeout: 1_000 },
  async () => {
    let aborted = false;
    const startedAt = Date.now();

    await assert.rejects(
      withCompletionAnalysisTimeout(
        (signal) =>
          new Promise<never>(() => {
            signal.addEventListener('abort', () => {
              aborted = true;
            });
          }),
        20
      ),
      CompletionAnalysisTimeoutError
    );

    assert.equal(aborted, true);
    assert.ok(Date.now() - startedAt < 1_000);
  }
);

test('completion analysis clears its timeout after ordinary completion', async () => {
  let aborted = false;
  const result = await withCompletionAnalysisTimeout(async (signal) => {
    signal.addEventListener('abort', () => {
      aborted = true;
    });
    return 'PASS';
  }, 20);
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(result, 'PASS');
  assert.equal(aborted, false);
});

test('detached completion uses independent catchup and 60s decision budgets and releases once', async () => {
  let releaseCount = 0;
  let observedCatchupMs = 0;
  const result = await withCompletionForegroundLease(
    async (_signal, catchupMs) => {
      observedCatchupMs = catchupMs;
      return () => releaseCount++;
    },
    async () => 'PASS',
    undefined,
    { catchupMs: 3_000, timeoutMs: 60_000 }
  );

  assert.equal(result, 'PASS');
  assert.equal(observedCatchupMs, 3_000);
  assert.equal(releaseCount, 1);

  await assert.rejects(
    withCompletionForegroundLease(
      async () => () => releaseCount++,
      async () => new Promise<never>(() => {}),
      undefined,
      { catchupMs: 20, timeoutMs: 10 }
    ),
    CompletionAnalysisTimeoutError
  );
  assert.equal(releaseCount, 2);

  const parent = new AbortController();
  let decisionAborted = false;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const cancelled = withCompletionForegroundLease(
    async () => () => releaseCount++,
    (signal) =>
      new Promise<never>(() => {
        markStarted();
        signal.addEventListener('abort', () => {
          decisionAborted = true;
        });
      }),
    parent.signal,
    { catchupMs: 50, timeoutMs: 50 }
  );
  await started;
  parent.abort();
  await assert.rejects(cancelled);
  assert.equal(decisionAborted, true);
  assert.equal(releaseCount, 3);
});

test('active-tool reconciliation removes terminal entries and preserves live work', () => {
  const activeTools = {
    terminal: { name: 'bash' },
    live: { name: 'edit' },
  };

  const remaining = reconcileActiveTools(activeTools, ['live']);

  assert.deepEqual(remaining, ['live']);
  assert.deepEqual(activeTools, { live: { name: 'edit' } });
});

test('missing completion evidence returns ordinary corrective feedback', () => {
  assert.equal(
    completionCorrection('16'),
    'Task #16 remains active because Advisor could not verify completion. Continue the work or add concrete evidence, then retry TaskUpdate.'
  );
});

test('completion recognizes deployed task-local evidence object and array shapes', () => {
  assert.equal(hasTaskLocalCompletionEvidence({ metadata: {} }), false);
  assert.equal(
    hasTaskLocalCompletionEvidence({
      metadata: {
        evidence: {
          source: 'ReadSeek read of evidence.txt',
          observed_text: 'P1_4_EVIDENCE',
          line: 1,
          line_hash: 'bf0',
          file_hash: '55742b73966ed3faa245c98216084065c76cd8f50ecf3727e2ac2a8508cca707',
        },
      },
    }),
    true
  );
  assert.equal(
    hasTaskLocalCompletionEvidence({
      metadata: {
        evidence: [
          {
            kind: 'validation-output',
            source: 'evidence.txt read back via read tool',
            claim: 'File content exactly matches required text',
            observed: 'P1_4_EVIDENCE',
            file_hash: '55742b73966ed3faa245c98216084065c76cd8f50ecf3727e2ac2a8508cca707',
          },
          {
            kind: 'commands-run',
            source: 'od -An -tx1 -c evidence.txt',
            observed: '13 bytes with no trailing newline',
          },
        ],
      },
    }),
    true
  );
  assert.equal(
    hasTaskLocalCompletionEvidence({
      metadata: { evidence: { kind: 'validation-output', claim: 'done' } },
    }),
    false
  );
});
