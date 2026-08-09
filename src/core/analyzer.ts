import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  buildCompactionSummary,
  extractMessages,
  formatForSupervisor,
} from '../compaction/index.js';
import { callAdvisorModel } from '../session/client.js';
import type { AdvisorDecision, AdvisorModelBinding, AdvisorState } from '../types.js';
import { ADVISOR_SYSTEM_PROMPT, buildAdvisorPrompt } from './prompt-builder.js';

export async function analyze(
  ctx: ExtensionContext,
  binding: AdvisorModelBinding,
  state: AdvisorState,
  mode: 'automatic' | 'question' | 'mutation',
  question?: string,
  hostContext?: string,
  signal: AbortSignal | undefined = ctx.signal
): Promise<AdvisorDecision> {
  const transcript = formatForSupervisor(buildCompactionSummary(extractMessages(ctx)));
  return callAdvisorModel(
    ctx,
    binding,
    ADVISOR_SYSTEM_PROMPT,
    buildAdvisorPrompt(state, transcript, mode, question, hostContext),
    signal
  );
}
