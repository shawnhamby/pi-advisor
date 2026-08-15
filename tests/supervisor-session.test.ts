import assert from 'node:assert/strict';
import test from 'node:test';
import { AdvisorSessionLanes, advisorSessionToolsEnabled } from '../src/session/client.ts';
import { advisorBuiltInTools, SupervisorSession } from '../src/session/supervisor-session.ts';

test('aborting a prompt immediately discards a provider request that does not settle', async () => {
  let disposed = false;
  const session = {
    subscribe: () => () => undefined,
    prompt: () => new Promise<void>(() => undefined),
    abort: () => new Promise<void>(() => undefined),
    dispose: () => {
      disposed = true;
    },
  };
  const supervisor = new SupervisorSession();
  Object.assign(supervisor, {
    session,
    model: { id: 'test-model' },
    systemPrompt: 'test prompt',
  });
  const controller = new AbortController();

  const result = supervisor.prompt('test', controller.signal);
  controller.abort();
  const outcome = await Promise.race([
    result,
    new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
  ]);

  assert.equal(outcome, null);
  assert.equal(disposed, true);
  assert.equal(Reflect.get(supervisor, 'session'), null);
});

test('completion disables private tools while automatic and question modes retain them', () => {
  assert.equal(advisorSessionToolsEnabled('completion'), false);
  assert.deepEqual(advisorBuiltInTools(advisorSessionToolsEnabled('completion')), []);

  for (const mode of ['automatic', 'question'] as const) {
    assert.equal(advisorSessionToolsEnabled(mode), true);
    assert.deepEqual(advisorBuiltInTools(advisorSessionToolsEnabled(mode)), [
      'read',
      'grep',
      'find',
    ]);
  }
});

test('standard sessions reuse while every completion invocation replaces its wrapper', () => {
  const sessions: Array<{ id: number; disposed: number }> = [];
  const lanes = new AdvisorSessionLanes(() => {
    const state = { id: sessions.length + 1, disposed: 0 };
    sessions.push(state);
    return {
      dispose: () => state.disposed++,
      ensureStarted: async () => true,
      prompt: async () => null,
    };
  });

  const standard = lanes.session('automatic', 'standard-a');
  assert.equal(lanes.session('question', 'standard-a'), standard);
  const completion = lanes.session('completion', 'completion-a');
  assert.notEqual(completion, standard);
  const nextCompletion = lanes.session('completion', 'completion-a');
  assert.notEqual(nextCompletion, completion);
  assert.equal(sessions[1].disposed, 1);

  const replacedStandard = lanes.session('automatic', 'standard-b');
  assert.notEqual(replacedStandard, standard);
  assert.equal(sessions[0].disposed, 1);
  assert.equal(sessions[2].disposed, 0);

  lanes.dispose();
  assert.deepEqual(
    sessions.map((session) => session.disposed),
    [1, 1, 1, 1]
  );
});

test('disposed completion startup cannot install or disturb a replacement session', async () => {
  const starts = [deferredStart(), deferredStart()];
  const created = [fakeProviderSession(), fakeProviderSession()];
  let wrapperIndex = 0;
  const lanes = new AdvisorSessionLanes(() => {
    const index = wrapperIndex++;
    return new SupervisorSession(async () => {
      starts[index].started();
      await starts[index].release;
      return { session: created[index] } as any;
    });
  });
  const context = fakeContext();
  const first = lanes.session('completion', 'same-key') as SupervisorSession;
  const firstStartup = first.ensureStarted(context, 'xai', 'grok-4.6', 'prompt', 'medium', false);
  await starts[0].waiting;

  const replacement = lanes.session('completion', 'same-key') as SupervisorSession;
  const replacementStartup = replacement.ensureStarted(
    context,
    'xai',
    'grok-4.6',
    'prompt',
    'medium',
    false
  );
  await starts[1].waiting;

  starts[0].finish();
  assert.equal(await firstStartup, false);
  assert.equal(created[0].disposed, 1);
  assert.equal(created[1].disposed, 0);
  assert.equal(Reflect.get(first, 'session'), null);

  starts[1].finish();
  assert.equal(await replacementStartup, true);
  assert.equal(Reflect.get(replacement, 'session'), created[1]);
  assert.equal(created[1].disposed, 0);

  lanes.dispose();
  assert.equal(created[1].disposed, 1);
});

function deferredStart(): {
  waiting: Promise<void>;
  release: Promise<void>;
  started(): void;
  finish(): void;
} {
  let started!: () => void;
  let finish!: () => void;
  return {
    waiting: new Promise<void>((resolve) => {
      started = resolve;
    }),
    release: new Promise<void>((resolve) => {
      finish = resolve;
    }),
    started: () => started(),
    finish: () => finish(),
  };
}

function fakeProviderSession() {
  return {
    disposed: 0,
    subscribe: () => () => undefined,
    prompt: async () => undefined,
    dispose() {
      this.disposed++;
    },
  };
}

function fakeContext(): any {
  const model = { id: 'grok-4.6' };
  return {
    cwd: process.cwd(),
    modelRegistry: {
      find: () => model,
    },
  };
}
