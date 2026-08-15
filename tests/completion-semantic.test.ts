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

test('a matching GAP is sticky while UNKNOWN can be retried', async () => {
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

  const unknownCache = new CompletionSemanticCache();
  let unknownRuns = 0;
  const run = async () => (++unknownRuns === 1 ? UNKNOWN : PASS);
  ask(unknownCache, 'unknown', run);
  await tick();
  assert.deepEqual(ask(unknownCache, 'unknown', run), { kind: 'pending', started: true });
  assert.equal(unknownRuns, 2);
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
