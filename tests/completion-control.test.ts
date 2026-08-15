import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CompletionAnalysisTimeoutError,
  completionCorrection,
  hasTaskLocalCompletionEvidence,
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

test('parent cancellation propagates through the independent completion phases', async () => {
  const parent = new AbortController();
  let decisionAborted = false;
  const result = withCompletionAnalysisBudget(
    async () => 'caught-up',
    (signal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          decisionAborted = true;
          reject(new Error('decision aborted'));
        });
      }),
    parent.signal,
    { catchupMs: 50, timeoutMs: 50 }
  );
  setTimeout(() => parent.abort(), 5);

  await assert.rejects(result);
  assert.equal(decisionAborted, true);
});

test('completion analysis receives its decision budget after catchup and remains bounded', async () => {
  const startedAt = Date.now();
  const result = await withCompletionAnalysisBudget(
    async (_signal, catchupMs) => {
      assert.equal(catchupMs, 40);
      await new Promise((resolve) => setTimeout(resolve, 30));
      return 'caught-up';
    },
    async (_signal, caught) => {
      assert.equal(caught, 'caught-up');
      await new Promise((resolve) => setTimeout(resolve, 15));
      return 'PASS';
    },
    undefined,
    { catchupMs: 40, timeoutMs: 20 }
  );

  assert.equal(result, 'PASS');
  assert.ok(Date.now() - startedAt > 20);

  let decisionStarted = false;
  let catchupAborted = false;
  await assert.rejects(
    withCompletionAnalysisBudget(
      (signal) =>
        new Promise<void>(() => {
          signal.addEventListener('abort', () => {
            catchupAborted = true;
          });
        }),
      async () => {
        decisionStarted = true;
        return 'unreachable';
      },
      undefined,
      { catchupMs: 20, timeoutMs: 60 }
    ),
    CompletionAnalysisTimeoutError
  );
  assert.equal(catchupAborted, true);
  assert.equal(decisionStarted, false);

  let decisionAborted = false;
  await assert.rejects(
    withCompletionAnalysisBudget(
      async () => 'caught-up',
      (signal) =>
        new Promise<never>(() => {
          signal.addEventListener('abort', () => {
            decisionAborted = true;
          });
        }),
      undefined,
      { catchupMs: 60, timeoutMs: 20 }
    ),
    CompletionAnalysisTimeoutError
  );
  assert.equal(decisionAborted, true);
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
