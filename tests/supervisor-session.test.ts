import assert from 'node:assert/strict';
import test from 'node:test';
import { SupervisorSession } from '../src/session/supervisor-session.ts';

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
