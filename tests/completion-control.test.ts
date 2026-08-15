import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CompletionAnalysisTimeoutError,
  completionCorrection,
  reconcileActiveTools,
  withCompletionAnalysisBudget,
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

test('completion analysis receives its decision budget after catchup and remains bounded', async () => {
  const result = await withCompletionAnalysisBudget(
    async (_signal, catchupMs) => {
      assert.equal(catchupMs, 30);
      await new Promise((resolve) => setTimeout(resolve, 35));
      return 'PASS';
    },
    undefined,
    { catchupMs: 30, timeoutMs: 20 }
  );

  assert.equal(result, 'PASS');

  await assert.rejects(
    withCompletionAnalysisBudget(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return 'late';
      },
      undefined,
      { catchupMs: 30, timeoutMs: 20 }
    ),
    CompletionAnalysisTimeoutError
  );
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
