import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CompletionAnalysisTimeoutError,
  completionEmission,
  completionCorrection,
  hasCompletionEvidence,
  hasTaskLocalCompletionEvidence,
  reconcileActiveTools,
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

test('completion result delivery triggers only actionable PASS and GAP decisions', () => {
  const pass = completionEmission('1', {
    verdict: 'PASS',
    action: 'silent',
    reasoning: 'verified',
    confidence: 0.9,
  });
  const gap = completionEmission('1', {
    verdict: 'GAP',
    action: 'continue',
    message: 'one check remains',
    reasoning: 'missing check',
    confidence: 0.9,
  });
  const unknown = completionEmission('1', {
    verdict: 'UNKNOWN',
    action: 'continue',
    reasoning: 'provider timed out',
    confidence: 0,
  });

  assert.equal(pass.triggerTurn, true);
  assert.equal(gap.triggerTurn, true);
  assert.equal(unknown.deliverAs, 'followUp');
  assert.equal(unknown.triggerTurn, false);
  assert.doesNotMatch(unknown.message, /retry|continue/i);
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

test('completion can enter semantic review from observed validation evidence', () => {
  const task = { id: '1', createdAt: 100, metadata: {} };
  assert.equal(
    hasCompletionEvidence(task, {
      toolEvidence: [
        {
          toolCallId: 'check-1',
          toolName: 'bash',
          input: { command: 'npm test' },
          validation: true,
          isError: false,
          outputDigest: 'abc123',
          outputPreview: 'tests passed',
          finishedAt: 101,
        },
      ],
    }),
    true
  );
  assert.equal(
    hasCompletionEvidence(task, {
      toolEvidence: [
        {
          toolCallId: 'read-1',
          toolName: 'read',
          input: {},
          validation: false,
          isError: false,
          outputDigest: 'abc123',
          outputPreview: 'looks done',
          finishedAt: 101,
        },
      ],
    }),
    false
  );
});
