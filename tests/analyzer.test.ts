import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADVISOR_SYSTEM_PROMPT,
  COMPLETION_TRANSCRIPT,
  transcriptForAnalysis,
} from '../src/core/prompt-builder.ts';

test('completion uses compact structured evidence while other modes retain the transcript', () => {
  assert.equal(transcriptForAnalysis('completion', 'full conversation'), COMPLETION_TRANSCRIPT);
  for (const mode of ['automatic', 'question'] as const) {
    assert.equal(transcriptForAnalysis(mode, 'full conversation'), 'full conversation');
  }
});

test('system prompt makes completion tool-free without removing automatic and question tools', () => {
  assert.match(
    ADVISOR_SYSTEM_PROMPT,
    /When MODE is completion, you have no private tools\. Judge only the supplied structured task, runtime, and host-verified evidence\./
  );
  assert.match(
    ADVISOR_SYSTEM_PROMPT,
    /Do not narrate or promise future inspection; return the strict JSON decision immediately\./
  );
  assert.match(
    ADVISOR_SYSTEM_PROMPT,
    /In automatic and question modes, your private tools are bounded read, grep, and find operations rooted at the active workspace\./
  );
});
