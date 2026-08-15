import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { callAdvisorModel } from '../session/client.js';
import type {
  AdvisorAnalysisMode,
  AdvisorDecision,
  AdvisorModelBinding,
  AdvisorState,
} from '../types.js';
import {
  ADVISOR_SYSTEM_PROMPT,
  buildAdvisorPrompt,
  transcriptForAnalysis,
} from './prompt-builder.js';
import { sanitizedTranscriptSnapshot } from './transcript-delta.js';

export async function analyze(
  ctx: ExtensionContext,
  binding: AdvisorModelBinding,
  state: AdvisorState,
  mode: AdvisorAnalysisMode,
  question?: string,
  hostContext?: string,
  signal?: AbortSignal,
  transcriptOverride?: string
): Promise<AdvisorDecision> {
  const transcript = transcriptForAnalysis(
    mode,
    mode === 'completion' ? undefined : sanitizedTranscriptSnapshot(ctx),
    transcriptOverride
  );
  return callAdvisorModel(
    ctx,
    binding,
    ADVISOR_SYSTEM_PROMPT,
    buildAdvisorPrompt(state, transcript, mode, question, hostContext),
    signal,
    mode
  );
}
