import type { AdvisorSeverity } from '../types.js';

const FILLER = new Set([
  'stop',
  'stop here',
  'stop now',
  'done',
  'task done',
  'task complete',
  'complete',
  'finished',
  'ok',
  'okay',
  'lgtm',
  'looks good',
  'all good',
  'no issue',
  'no issues',
  'no issue continue',
  'no concerns',
  'nothing to add',
  'nothing to flag',
  'nothing to report',
  'no further advice',
  'continue',
  'carry on',
]);

const SEVERITY_RANK: Record<AdvisorSeverity, number> = {
  nit: 1,
  concern: 2,
  blocker: 3,
};

export function normalizeAdvisorNote(note: string): string {
  return note
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export class AdvisorEmissionGuard {
  private delivered = new Map<string, number>();

  reset(): void {
    this.delivered.clear();
  }

  accept(note: string, severity: AdvisorSeverity): boolean {
    const key = normalizeAdvisorNote(note);
    if (!key || FILLER.has(key)) return false;
    const rank = SEVERITY_RANK[severity];
    if (rank <= (this.delivered.get(key) ?? 0)) return false;
    this.delivered.set(key, rank);
    if (this.delivered.size > 4096) this.delivered.delete(this.delivered.keys().next().value!);
    return true;
  }
}

const OUTPUT_HAZARDS = [
  /\bignore\s+(?:all\s+)?(?:prior|previous|earlier)\s+(?:user\s+)?instructions\b/i,
  /<\/?(?:system|developer|user|assistant)(?:\s|>)/i,
  /\byou are now\b.{0,80}\b(?:system|developer|administrator)\b/i,
  /\brm\s+(?=(?:-[a-z]+\s*)*-[a-z]*r[a-z]*)(?=(?:-[a-z]+\s*)*-[a-z]*f[a-z]*)/i,
];

export function advisorOutputIsQuarantined(value: string): boolean {
  return OUTPUT_HAZARDS.some((pattern) => pattern.test(value));
}
