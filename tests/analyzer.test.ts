import assert from 'node:assert/strict';
import test from 'node:test';
import { COMPLETION_TRANSCRIPT, transcriptForAnalysis } from '../src/core/prompt-builder.ts';

test('completion uses compact structured evidence while other modes retain the transcript', () => {
  assert.equal(transcriptForAnalysis('completion', 'full conversation'), COMPLETION_TRANSCRIPT);
  for (const mode of ['automatic', 'question'] as const) {
    assert.equal(transcriptForAnalysis(mode, 'full conversation'), 'full conversation');
  }
});
