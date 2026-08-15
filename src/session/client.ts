import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AdvisorAnalysisMode, AdvisorDecision, AdvisorModelBinding } from '../types.js';
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
  signal?: AbortSignal,
  mode: AdvisorAnalysisMode = 'automatic'
): Promise<AdvisorDecision> {
  const toolsEnabled = advisorSessionToolsEnabled(mode);
  const key = `${ctx.cwd}\u0000${binding.provider}\u0000${binding.modelId}\u0000${binding.effort}\u0000${toolsEnabled}`;
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
    binding.effort,
    toolsEnabled
  );
  if (!started) return unknown('advisor model session could not start');
  const text = await activeSession.prompt(userPrompt, signal);
  return text === null ? unknown('advisor model call failed') : parseDecision(text);
}

export function advisorSessionToolsEnabled(mode: AdvisorAnalysisMode): boolean {
  return mode !== 'completion';
}
