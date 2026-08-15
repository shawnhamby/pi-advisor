import assert from 'node:assert/strict';
import test from 'node:test';
import { IncrementalAdvisorQueue } from '../src/core/background-queue.ts';

test('foreground checks preempt stale automatic analysis', async () => {
  let signalBackgroundStarted!: () => void;
  const backgroundStarted = new Promise<void>((resolve) => {
    signalBackgroundStarted = resolve;
  });
  let backgroundAborted = false;
  const queue = new IncrementalAdvisorQueue<string>(async ({ signal }) => {
    signalBackgroundStarted();
    await new Promise<void>((resolve) => {
      signal.addEventListener(
        'abort',
        () => {
          backgroundAborted = true;
          resolve();
        },
        { once: true }
      );
    });
  });

  queue.enqueue('stale automatic update');
  await backgroundStarted;

  const result = await queue.runForeground(async () => 'PASS', 100);

  assert.equal(result, 'PASS');
  assert.equal(backgroundAborted, true);
});
