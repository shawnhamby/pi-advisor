import type { ToolCallEvent, ToolCallEventResult } from '@earendil-works/pi-coding-agent';
import { activeTask, AdvisorStateManager } from './state/manager.js';

const COMPLETION_TOOLS = new Set([
  'task_evidence',
  'task_decision',
  'task_update',
  'task_complete',
]);

export function gateTaskCall(
  event: ToolCallEvent,
  manager: AdvisorStateManager
): ToolCallEventResult | undefined {
  if (!COMPLETION_TOOLS.has(event.toolName)) return undefined;
  const input = event.input as Record<string, any>;
  const task = activeTask(manager.get().taskState);

  if (event.toolName === 'task_evidence') {
    // pi-tasks exposes the tool argument as the string enum "true" while its
    // reducer stores the normalized evidence value as boolean true.
    if (
      input.type === 'user_acceptance' &&
      !trustedUserAcceptance(manager.get().lastTrustedInput)
    ) {
      return reject('User acceptance requires explicit, runtime-proven user input');
    }
    if (input.passed === 'true' && input.type !== 'note' && !hasRuntimeEvidence(input, manager)) {
      return reject(
        'Passing task evidence must reference an observed successful tool result or touched artifact'
      );
    }
    return undefined;
  }

  if (event.toolName === 'task_decision') {
    if (input.decided_by === 'user' && !trustedUserDecision(manager.get().lastTrustedInput)) {
      return reject('A user-owned task decision requires explicit, runtime-proven user input');
    }
    return undefined;
  }

  if (event.toolName === 'task_update' && input.step_status === 'done') {
    if (!task || input.task_id !== task.id)
      return reject('Step completion does not match the active task');
    const evidenceIds = new Set(
      Array.isArray(input.step_evidence_ids) ? input.step_evidence_ids : []
    );
    const known = new Set(
      (task.task.evidence ?? [])
        .filter((item: any) => item.passed === true)
        .map((item: any) => item.id)
    );
    if (evidenceIds.size === 0 || [...evidenceIds].some((id) => !known.has(id))) {
      return reject('Step completion requires existing passing evidence linked to this task');
    }
    return undefined;
  }

  if (event.toolName === 'task_complete') {
    if (!task || input.task_id !== task.id)
      return reject('Completion does not match the active task');
    if (input.force_with_reason && !trustedForceCompletion(manager.get().lastTrustedInput)) {
      return reject('Forced completion requires explicit, runtime-proven user direction');
    }
    if (
      Array.isArray(input.criterion_results) &&
      input.criterion_results.some((item: any) => item?.status === 'skipped') &&
      !trustedCriterionSkip(manager.get().lastTrustedInput)
    ) {
      return reject('Skipped acceptance criteria require explicit, runtime-proven user direction');
    }
    if (!manager.consumePermit(task.id)) {
      manager.markCompletionRequested(task.id);
      return reject(
        'Advisor has not issued a current one-use completion permit; reconcile the settled task first'
      );
    }
  }

  return undefined;
}

function hasRuntimeEvidence(input: Record<string, any>, manager: AdvisorStateManager): boolean {
  const references = [
    ...(Array.isArray(input.references) ? input.references : []),
    ...(Array.isArray(input.quality?.artifactRefs) ? input.quality.artifactRefs : []),
  ]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
  if (references.length === 0) return false;
  const state = manager.get();
  const touched = new Set(state.touchedFiles.map(normalizeReference));
  return references.some((reference) => {
    const normalized = normalizeReference(reference);
    return (
      touched.has(normalized) ||
      state.toolEvidence.some(
        (evidence) =>
          !evidence.isError &&
          (evidence.toolCallId === reference || exactPathReferences(evidence.input).has(normalized))
      )
    );
  });
}

function normalizeReference(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function exactPathReferences(input: Record<string, unknown>): Set<string> {
  return new Set(
    [input.path, input.file, input.filePath, input.file_path, input.target]
      .filter((value): value is string => typeof value === 'string')
      .map(normalizeReference)
  );
}

type TrustedInput = { text: string; at: number } | undefined;

function recent(input: TrustedInput): input is { text: string; at: number } {
  return !!input && Date.now() - input.at <= 10 * 60_000;
}

function trustedUserAcceptance(input: TrustedInput): boolean {
  return (
    recent(input) && /\b(?:accept|accepted|approve|approved|looks good|done)\b/i.test(input.text)
  );
}

function trustedUserDecision(input: TrustedInput): boolean {
  return (
    recent(input) &&
    /\b(?:i (?:choose|want|prefer|decide)|use|choose|go with|agreed?)\b/i.test(input.text)
  );
}

function trustedForceCompletion(input: TrustedInput): boolean {
  return recent(input) && /\b(?:force|mark|treat).{0,30}\b(?:complete|done)\b/i.test(input.text);
}

function trustedCriterionSkip(input: TrustedInput): boolean {
  return recent(input) && /\b(?:skip|omit|ignore|not needed|out of scope)\b/i.test(input.text);
}

function reject(reason: string): ToolCallEventResult {
  return { block: true, terminate: true, reason };
}
