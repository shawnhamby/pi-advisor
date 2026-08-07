import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AdvisorDecision, AdvisorModelBinding } from '../types.js';
import { SupervisorSession } from './supervisor-session.js';
import { parseDecision, unknown } from './response-parser.js';

let activeSession: SupervisorSession | undefined;
let activeKey: string | undefined;

export function disposeAdvisorSession(): void {
  activeSession?.dispose();
  activeSession = undefined;
  activeKey = undefined;
}

export async function callAdvisorModel(
  ctx: ExtensionContext,
  binding: AdvisorModelBinding,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal
): Promise<AdvisorDecision> {
  const key = `${ctx.cwd}\u0000${binding.provider}\u0000${binding.modelId}\u0000${binding.effort}`;
  if (!activeSession || activeKey !== key) {
    disposeAdvisorSession();
    activeSession = new SupervisorSession();
    activeKey = key;
  }
  const started = await activeSession.ensureStarted(
    ctx,
    binding.provider,
    binding.modelId,
    systemPrompt,
    binding.effort
  );
  if (!started) return unknown('advisor model session could not start');
  const text = await activeSession.prompt(userPrompt, signal);
  return text === null ? unknown('advisor model call failed') : parseDecision(text);
}
