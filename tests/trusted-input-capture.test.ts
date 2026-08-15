import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionContext, InputEvent } from '@earendil-works/pi-coding-agent';
import { captureTrustedInput } from '../src/core/trusted-input-capture.ts';

test('host rejection skips trusted-input state persistence', async () => {
  let persisted = false;

  const captured = await captureTrustedInput({
    accept: async () => false,
    event: inputEvent('protected value'),
    ctx: {} as ExtensionContext,
    capture: () => {
      persisted = true;
    },
  });

  assert.equal(captured, false);
  assert.equal(persisted, false);
});

test('host predicate failure skips trusted-input state persistence', async () => {
  let persisted = false;

  const captured = await captureTrustedInput({
    accept: async () => {
      throw new Error('predicate unavailable');
    },
    event: inputEvent('protected value'),
    ctx: {} as ExtensionContext,
    capture: () => {
      persisted = true;
    },
  });

  assert.equal(captured, false);
  assert.equal(persisted, false);
});

test('accepted input preserves trusted-input state behavior', async () => {
  const persisted: InputEvent[] = [];

  const event = inputEvent('accepted objective');
  const captured = await captureTrustedInput({
    accept: async () => true,
    event,
    ctx: {} as ExtensionContext,
    capture: () => {
      persisted.push(event);
    },
  });

  assert.equal(captured, true);
  assert.deepEqual(persisted, [event]);
});

function inputEvent(text: string): InputEvent {
  return {
    type: 'input',
    text,
    source: 'interactive',
  };
}
