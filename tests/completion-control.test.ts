import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CompletionAnalysisTimeoutError,
  completionEmission,
  completionCorrection,
  hasCompletionEvidence,
  hasTaskLocalCompletionEvidence,
  planSettledCompletionActions,
  reconcileActiveTools,
  shouldResumeBoundWork,
  toolCallIdsRelated,
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

test('active-tool reconciliation drops every entry when no calls are live', () => {
  const activeTools = {
    'call_a|fc_1': { name: 'herdr_agent' },
    'call_b|fc_2': { name: 'herdr_pane' },
  };

  assert.deepEqual(reconcileActiveTools(activeTools, []), []);
  assert.deepEqual(activeTools, {});
});

test('related tool ids match composite provider suffixes', () => {
  assert.equal(
    toolCallIdsRelated('call_a|fc_1', 'call_a|fc_1'),
    true
  );
  assert.equal(toolCallIdsRelated('call_a', 'call_a|fc_1'), true);
  assert.equal(toolCallIdsRelated('call_a|fc_1', 'call_b|fc_2'), false);
});

test('bound-work resume requires an objective, no live tools, and no pending input', () => {
  assert.equal(
    shouldResumeBoundWork({
      hasPendingMessages: false,
      liveToolCount: 0,
      substantial: true,
      hasObjective: true,
    }),
    true
  );
  assert.equal(
    shouldResumeBoundWork({
      hasPendingMessages: true,
      liveToolCount: 0,
      substantial: true,
      hasObjective: true,
    }),
    false
  );
  assert.equal(
    shouldResumeBoundWork({
      hasPendingMessages: false,
      liveToolCount: 2,
      substantial: true,
      hasObjective: true,
    }),
    false
  );
  assert.equal(
    shouldResumeBoundWork({
      hasPendingMessages: false,
      liveToolCount: 0,
      substantial: true,
      hasObjective: false,
    }),
    false
  );
});

test('missing completion evidence returns ordinary corrective feedback', () => {
  assert.equal(
    completionCorrection('16'),
    'Task #16 remains active because Advisor could not verify completion. Continue the work or add concrete evidence, then retry TaskUpdate.'
  );
  assert.match(
    completionCorrection('16', 'observed completion evidence is missing', true),
    /TaskUpdate status=deleted/
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

test('settled unverified completes abandon missing-evidence tasks and keep gaps', () => {
  const cases = [
    {
      name: 'pending probe without evidence is abandoned',
      reconciliations: {
        '1': { reason: 'missing', kind: 'missing-evidence' as const, nudged: false },
      },
      tasks: { '1': { id: '1', status: 'pending' } },
      abandon: ['1'],
      nudge: [] as string[],
      drop: [] as string[],
    },
    {
      name: 'second pending probe is abandoned with the first',
      reconciliations: {
        '1': { reason: 'missing', kind: 'missing-evidence' as const, nudged: false },
        '2': { reason: 'missing', kind: 'missing-evidence' as const, nudged: true },
      },
      tasks: {
        '1': { id: '1', status: 'pending' },
        '2': { id: '2', status: 'in_progress' },
      },
      abandon: ['1', '2'],
      nudge: [] as string[],
      drop: [] as string[],
    },
    {
      name: 'gap stays open for one nudge',
      reconciliations: {
        '3': { reason: 'tests remain', kind: 'gap' as const, nudged: false },
      },
      tasks: { '3': { id: '3', status: 'in_progress' } },
      abandon: [] as string[],
      nudge: ['3'],
      drop: [] as string[],
    },
    {
      name: 'missing-evidence is abandoned even if validation evidence later appeared',
      reconciliations: {
        '4': { reason: 'missing', kind: 'missing-evidence' as const, nudged: false },
      },
      tasks: { '4': { id: '4', status: 'pending' } },
      abandon: ['4'],
      nudge: [] as string[],
      drop: [] as string[],
    },
    {
      name: 'unavailable async/unknown verification is abandoned at settle',
      reconciliations: {
        '7': {
          reason: 'did not converge',
          kind: 'unavailable' as const,
          nudged: false,
        },
      },
      tasks: { '7': { id: '7', status: 'in_progress' } },
      abandon: ['7'],
      nudge: [] as string[],
      drop: [] as string[],
    },
    {
      name: 'completed or missing tasks are dropped',
      reconciliations: {
        '5': { reason: 'missing', kind: 'missing-evidence' as const, nudged: false },
        '6': { reason: 'missing', kind: 'missing-evidence' as const, nudged: false },
      },
      tasks: { '5': { id: '5', status: 'completed' } },
      abandon: [] as string[],
      nudge: [] as string[],
      drop: ['5', '6'],
    },
  ];

  for (const fixture of cases) {
    const result = planSettledCompletionActions({
      reconciliations: fixture.reconciliations,
      tasks: fixture.tasks,
    });
    assert.deepEqual(
      result.abandon.map((entry) => entry.taskId),
      fixture.abandon,
      fixture.name
    );
    assert.deepEqual(
      result.nudge.map((entry) => entry.taskId),
      fixture.nudge,
      fixture.name
    );
    assert.deepEqual(result.drop, fixture.drop, fixture.name);
  }
});
