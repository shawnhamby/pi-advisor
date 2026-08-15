import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CompletionSemanticCache,
  completionSignature,
  type CompletionRuntimeSnapshot,
} from '../src/core/completion-semantic.ts';
import type { AdvisorDecision, AdvisorState } from '../src/types.ts';

const PASS: AdvisorDecision = {
  verdict: 'PASS',
  action: 'silent',
  reasoning: 'verified',
  confidence: 0.9,
};
const GAP: AdvisorDecision = {
  verdict: 'GAP',
  action: 'continue',
  message: 'one acceptance check remains',
  reasoning: 'missing check',
  confidence: 0.9,
};
const UNKNOWN: AdvisorDecision = {
  verdict: 'UNKNOWN',
  action: 'continue',
  reasoning: 'provider timed out',
  confidence: 0,
};

test('semantic completion starts immediately and deduplicates a matching check', async () => {
  const cache = new CompletionSemanticCache();
  const pending = deferred<AdvisorDecision>();
  let runs = 0;
  let followUps = 0;
  const request = () =>
    ask(
      cache,
      'same',
      async () => {
        runs++;
        return pending.promise;
      },
      () => true,
      () => followUps++
    );

  assert.deepEqual(request(), { kind: 'pending', started: true });
  assert.deepEqual(request(), { kind: 'pending', started: false });
  assert.equal(runs, 1);
  assert.equal(followUps, 0);

  pending.resolve(PASS);
  await tick();
  assert.equal(followUps, 1);
});

test('a matching PASS is a one-use permit', async () => {
  const cache = new CompletionSemanticCache();
  const first = deferred<AdvisorDecision>();
  const second = deferred<AdvisorDecision>();
  let runs = 0;
  const run = () => (++runs === 1 ? first.promise : second.promise);

  assert.deepEqual(ask(cache, 'pass', run), { kind: 'pending', started: true });
  first.resolve(PASS);
  await tick();
  assert.deepEqual(ask(cache, 'pass', run), { kind: 'pass' });
  assert.deepEqual(ask(cache, 'pass', run), { kind: 'pending', started: true });
  assert.equal(runs, 2);
  second.resolve(UNKNOWN);
});

test('a PASS permit expires after 60 seconds', async () => {
  let now = 1_000;
  const cache = new CompletionSemanticCache(60_000, () => now);
  let runs = 0;
  const run = async () => {
    runs++;
    return PASS;
  };

  assert.deepEqual(ask(cache, 'pass-ttl', run), { kind: 'pending', started: true });
  await tick();
  now += 60_001;
  assert.deepEqual(ask(cache, 'pass-ttl', run), { kind: 'pending', started: true });
  assert.equal(runs, 2);
});

test('a matching GAP is sticky while UNKNOWN enters a 60 second cooldown', async () => {
  const gapCache = new CompletionSemanticCache();
  let gapRuns = 0;
  ask(
    gapCache,
    'gap',
    async () => {
      gapRuns++;
      return GAP;
    },
    () => true,
    () => {}
  );
  await tick();
  const firstGap = ask(gapCache, 'gap', async () => PASS);
  const secondGap = ask(gapCache, 'gap', async () => PASS);
  assert.equal(firstGap.kind, 'gap');
  assert.equal(secondGap.kind, 'gap');
  assert.equal(gapRuns, 1);

  let now = 1_000;
  const unknownCache = new CompletionSemanticCache(60_000, () => now);
  let unknownRuns = 0;
  const run = async () => (++unknownRuns === 1 ? UNKNOWN : PASS);
  ask(unknownCache, 'unknown', run);
  await tick();
  assert.equal(ask(unknownCache, 'unknown', run).kind, 'cooldown');
  assert.equal(unknownRuns, 1);
  now += 60_001;
  assert.deepEqual(ask(unknownCache, 'unknown', run), { kind: 'pending', started: true });
  assert.equal(unknownRuns, 2);
});

test('a newer different signature preempts the sole running completion check', async () => {
  const cache = new CompletionSemanticCache();
  const first = deferred<AdvisorDecision>();
  const second = deferred<AdvisorDecision>();
  let firstAborted = false;
  let firstFollowUps = 0;
  let secondFollowUps = 0;

  ask(
    cache,
    'first',
    (signal) => {
      signal.addEventListener('abort', () => {
        firstAborted = true;
      });
      return first.promise;
    },
    () => true,
    () => firstFollowUps++
  );
  assert.deepEqual(
    ask(
      cache,
      'second',
      () => second.promise,
      () => true,
      () => secondFollowUps++
    ),
    { kind: 'pending', started: true }
  );
  assert.equal(firstAborted, true);

  first.resolve(PASS);
  second.resolve(PASS);
  await tick();
  assert.equal(firstFollowUps, 0);
  assert.equal(secondFollowUps, 1);
  assert.deepEqual(
    ask(cache, 'second', async () => UNKNOWN),
    { kind: 'pass' }
  );
});

test('state invalidation clears UNKNOWN cooldown and suppresses its stale generation', async () => {
  const cache = new CompletionSemanticCache();
  let runs = 0;
  ask(cache, 'same', async () => {
    runs++;
    return UNKNOWN;
  });
  await tick();
  assert.equal(ask(cache, 'same', async () => PASS).kind, 'cooldown');

  cache.invalidate();
  assert.deepEqual(
    ask(cache, 'same', async () => {
      runs++;
      return PASS;
    }),
    { kind: 'pending', started: true }
  );
  await tick();
  assert.equal(runs, 2);
  assert.deepEqual(
    ask(cache, 'same', async () => UNKNOWN),
    { kind: 'pass' }
  );
});

test('invalidation aborts work and suppresses late cache and follow-up', async () => {
  const cache = new CompletionSemanticCache();
  const pending = deferred<AdvisorDecision>();
  let aborted = false;
  let followUps = 0;
  ask(
    cache,
    'late',
    async (signal) => {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      return pending.promise;
    },
    () => true,
    () => followUps++
  );

  cache.invalidate();
  pending.resolve(PASS);
  await tick();
  assert.equal(aborted, true);
  assert.equal(followUps, 0);
  assert.deepEqual(
    ask(cache, 'late', async () => UNKNOWN),
    {
      kind: 'pending',
      started: true,
    }
  );
});

test('signature revalidation suppresses a result after uncached context drift', async () => {
  const cache = new CompletionSemanticCache();
  const pending = deferred<AdvisorDecision>();
  let current = true;
  let followUps = 0;
  ask(
    cache,
    'drift',
    () => pending.promise,
    () => current,
    () => followUps++
  );
  current = false;
  pending.resolve(PASS);
  await tick();

  assert.equal(followUps, 0);
  assert.deepEqual(
    ask(cache, 'drift', async () => UNKNOWN),
    {
      kind: 'pending',
      started: true,
    }
  );
});

test('task-local evidence drift suppresses a late semantic result', async () => {
  const cache = new CompletionSemanticCache();
  const pending = deferred<AdvisorDecision>();
  const currentState = state();
  const runtime = runtimeState();
  const task = { id: '1', metadata: { evidence: { observed: 'before' } } };
  const signature = completionSignature('1', task, currentState, runtime);
  let followUps = 0;

  ask(
    cache,
    signature,
    () => pending.promise,
    () => completionSignature('1', task, currentState, runtime) === signature,
    () => followUps++
  );
  task.metadata.evidence.observed = 'after';
  pending.resolve(PASS);
  await tick();

  assert.equal(followUps, 0);
  assert.notEqual(completionSignature('1', task, currentState, runtime), signature);
});

test('successful observation tools do not cancel or stale a pending completion check', async () => {
  const cache = new CompletionSemanticCache();
  const pending = deferred<AdvisorDecision>();
  const currentState = state();
  const runtime = runtimeState();
  const task = { id: '1', subject: 'demo' };
  const signature = completionSignature('1', task, currentState, runtime);
  let followUps = 0;

  ask(
    cache,
    signature,
    () => pending.promise,
    () => completionSignature('1', task, currentState, runtime) === signature,
    () => followUps++
  );
  for (const [toolName, input] of [
    ['grep', { pattern: 'P1_4' }],
    ['readSeek_digest', { path: 'evidence.txt' }],
    ['lsp_definition', { path: 'evidence.py' }],
    ['TaskGet', { taskId: '1' }],
    ['TaskList', {}],
    ['subagent_wait', { id: 'run-1' }],
    ['subagent', { action: 'status', id: 'run-1' }],
    ['list_agents', {}],
    ['herdr_layout', { action: 'current' }],
    ['herdr_pane', { action: 'read', pane: 'p1' }],
    ['herdr_agent', { action: 'list' }],
  ] as const) {
    cache.invalidateForTool(toolName, input);
    currentState.activeTools[toolName] = { name: toolName, startedAt: 1 };
    delete currentState.activeTools[toolName];
    currentState.toolEvidence.push(evidence(toolName));
    cache.invalidateForTool(toolName, input);
  }
  pending.resolve(PASS);
  await tick();

  assert.equal(followUps, 1);
  assert.deepEqual(
    ask(cache, signature, async () => UNKNOWN),
    { kind: 'pass' }
  );
});

test('mutating, executing, mixed, unknown, and failed observation tools invalidate', () => {
  for (const [toolName, input, isError] of [
    ['bash', { command: 'pwd' }, false],
    ['write', { path: 'evidence.txt' }, false],
    ['TaskUpdate', { taskId: '1', status: 'in_progress' }, false],
    ['spawn_agent', { task: 'work' }, false],
    ['create_thread', { prompt: 'work' }, false],
    ['subagent', { agent: 'coding', task: 'work' }, false],
    ['subagent', { action: 'status', id: 'run-1' }, true],
    ['subagent', { action: 'steer', id: 'run-1' }, false],
    ['herdr_agent', { action: 'prompt' }, false],
    ['custom_unknown_tool', {}, false],
  ] as const) {
    const cache = new CompletionSemanticCache();
    const pending = deferred<AdvisorDecision>();
    let aborted = false;
    ask(cache, toolName, (signal) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        pending.resolve(PASS);
      });
      return pending.promise;
    });
    cache.invalidateForTool(toolName, input, isError);
    assert.equal(aborted, true, toolName);
  }
});

test('completion signature contains authoritative facts, not later tool activity', () => {
  const currentState = state();
  const runtime = runtimeState();
  const task = { id: '1', subject: 'demo', metadata: { evidence: { observed: 'done' } } };
  const signature = completionSignature('1', task, currentState, runtime);

  currentState.activeTools.write = { name: 'write', startedAt: 1 };
  currentState.toolEvidence.push(evidence('write'));
  assert.equal(completionSignature('1', task, currentState, runtime), signature);

  currentState.blockers.push('write failed');
  assert.notEqual(completionSignature('1', task, currentState, runtime), signature);
  currentState.blockers = [];
  task.metadata.evidence.observed = 'changed';
  assert.notEqual(completionSignature('1', task, currentState, runtime), signature);
});

test('signature is key-stable and excludes Advisor bookkeeping', () => {
  const runtime: CompletionRuntimeSnapshot = {
    cwd: '/tmp/example',
    modelProvider: 'openai-codex',
    modelId: 'gpt-5.6-sol',
    systemPromptDigest: 'system',
  };
  const left = state();
  left.lastAnalysisAt = 1;
  left.lastEmissionAt = 2;
  left.completionReconciliation = { taskId: '1', reason: 'old', nudged: true };
  const right = state();
  right.lastAnalysisAt = 99;
  right.lastEmissionAt = 100;

  const first = completionSignature('1', { subject: 'demo', id: '1' }, left, runtime);
  const reordered = completionSignature('1', { id: '1', subject: 'demo' }, right, runtime);
  assert.equal(first, reordered);
  right.validationAt = 42;
  assert.notEqual(first, completionSignature('1', { id: '1', subject: 'demo' }, right, runtime));
});

function state(): AdvisorState {
  return {
    version: 1,
    instructions: [{ id: 'global' }],
    touchedFiles: ['evidence.txt'],
    blockers: [],
    toolEvidence: [],
    activeTools: {},
    trustedInputs: [],
  };
}

function runtimeState(): CompletionRuntimeSnapshot {
  return {
    cwd: '/tmp/example',
    modelProvider: 'openai-codex',
    modelId: 'gpt-5.6-sol',
    systemPromptDigest: 'system',
  };
}

function evidence(toolName: string): AdvisorState['toolEvidence'][number] {
  return {
    toolCallId: `${toolName}-1`,
    toolName,
    input: {},
    isError: false,
    outputDigest: 'digest',
    outputPreview: 'complete',
    finishedAt: 1,
  };
}

function ask(
  cache: CompletionSemanticCache,
  signature: string,
  run: (signal: AbortSignal) => Promise<AdvisorDecision>,
  current = () => true,
  settled = (_decision: AdvisorDecision) => {}
) {
  return cache.request(signature, run, current, settled);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
