import type { AdvisorDecision } from '../types.js';
import { advisorOutputIsQuarantined } from '../core/emission-guard.js';

export function parseDecision(text: string): AdvisorDecision {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\})/);
  try {
    const parsed = JSON.parse(match?.[1] ?? text.trim()) as Partial<AdvisorDecision>;
    const verdict = parsed.verdict;
    const action = parsed.action;
    if (!(['PASS', 'GAP', 'UNKNOWN'] as const).includes(verdict as never))
      return unknown('invalid verdict');
    if (!(['silent', 'warn', 'continue', 'blocker', 'answer'] as const).includes(action as never)) {
      return unknown('invalid action');
    }
    const decision: AdvisorDecision = {
      verdict: verdict!,
      action: action!,
      message: typeof parsed.message === 'string' ? parsed.message.trim() : undefined,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.trim() : '',
      confidence:
        typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
      objectiveInputAt:
        typeof parsed.objectiveInputAt === 'number' ? parsed.objectiveInputAt : undefined,
    };
    if (advisorOutputIsQuarantined(`${decision.message ?? ''}\n${decision.reasoning}`)) {
      return unknown('advisor output quarantined');
    }
    return decision;
  } catch {
    return unknown('invalid JSON');
  }
}

export function unknown(reason: string): AdvisorDecision {
  return { verdict: 'UNKNOWN', action: 'silent', reasoning: reason, confidence: 0 };
}
