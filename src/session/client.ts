import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AdvisorAnalysisMode, AdvisorDecision, AdvisorModelBinding } from '../types.js';
import { SupervisorSession } from './supervisor-session.js';
import { parseDecision, unknown } from './response-parser.js';

type AdvisorSession = Pick<SupervisorSession, 'dispose' | 'ensureStarted' | 'prompt'>;
type AdvisorSessionLane = 'standard' | 'completion';
type AdvisorSessionSlot = { session: AdvisorSession; key: string };

export class AdvisorSessionLanes {
  private readonly slots: Partial<Record<AdvisorSessionLane, AdvisorSessionSlot>> = {};

  constructor(
    private readonly createSession: () => AdvisorSession = () => new SupervisorSession()
  ) {}

  session(mode: AdvisorAnalysisMode, key: string): AdvisorSession {
    const lane = mode === 'completion' ? 'completion' : 'standard';
    const current = this.slots[lane];
    if (lane === 'standard' && current?.key === key) return current.session;
    current?.session.dispose();
    const session = this.createSession();
    this.slots[lane] = { session, key };
    return session;
  }

  dispose(): void {
    for (const slot of Object.values(this.slots)) slot?.session.dispose();
    delete this.slots.standard;
    delete this.slots.completion;
  }
}

const activeSessions = new AdvisorSessionLanes();

export function disposeAdvisorSession(): void {
  activeSessions.dispose();
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
  const session = activeSessions.session(mode, key);
  const started = await session.ensureStarted(
    ctx,
    binding.provider,
    binding.modelId,
    systemPrompt,
    binding.effort,
    toolsEnabled
  );
  if (!started) return unknown('advisor model session could not start');
  const text = await session.prompt(userPrompt, signal);
  return text === null ? unknown('advisor model call failed') : parseDecision(text);
}

export function advisorSessionToolsEnabled(mode: AdvisorAnalysisMode): boolean {
  return mode !== 'completion';
}
