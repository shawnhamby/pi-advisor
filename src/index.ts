import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { Container, Text } from '@earendil-works/pi-tui';
import { analyze } from './core/analyzer.js';
import { gateTaskCall } from './gate.js';
import { disposeAdvisorSession } from './session/client.js';
import { activeTask, AdvisorStateManager } from './state/manager.js';
import type {
  AdvisorDecision,
  AdvisorHostOptions,
  AdvisorModelBinding,
  AdvisorSeverity,
  InstructionReference,
  PlanBinding,
  ToolEvidence,
} from './types.js';

const TASK_STATE_EVENT = 'pi-tasks:state';
const ADVISOR_MESSAGE = 'pi-advisor';
const CONTINUITY_EVENT = 'pi-advisor:continuity-restored';
const HIGH_SIGNAL_TOOLS =
  /^(?:bash|exec|edit|write|task_plan|task_update|task_evidence|task_complete|spawn_agent|create_thread)$/i;
const MUTATION_TOOLS = /(?:edit|write|patch|delete|create|rename|move)/i;

export function createAdvisorExtension(options: AdvisorHostOptions) {
  return function advisorExtension(pi: ExtensionAPI): void {
    const manager = new AdvisorStateManager(pi);
    const pendingInputs = new Map<string, { name: string; input: Record<string, unknown> }>();
    let inputEpoch = 0;
    let activityEpoch = 0;
    let substantial = false;
    let routeLabel: string | undefined;

    const emit = (
      message: string,
      severity: AdvisorSeverity,
      ctx: ExtensionContext,
      continuation = false
    ): void => {
      const trimmed = message.trim();
      if (!trimmed) return;
      const signature = digest(`${severity}\u0000${trimmed}`);
      if (!manager.emissionAllowed(signature)) return;
      const details = { notes: [{ note: trimmed, severity }], route: routeLabel };
      pi.sendMessage(
        {
          customType: ADVISOR_MESSAGE,
          content: `<advisor severity="${severity}">${trimmed}</advisor>`,
          display: true,
          details,
        },
        continuation
          ? { deliverAs: 'followUp', triggerTurn: true }
          : { deliverAs: 'steer', triggerTurn: false }
      );
    };

    const resolveBinding = async (
      ctx: ExtensionContext
    ): Promise<AdvisorModelBinding | undefined> => {
      try {
        const binding = await options.resolveModel(ctx);
        routeLabel = binding?.selector;
        return binding;
      } catch (error) {
        routeLabel = undefined;
        emit(
          `Advisor route failed: ${error instanceof Error ? error.message : String(error)}`,
          'blocker',
          ctx
        );
        return undefined;
      }
    };

    const applyPromptMetadata = async (
      event: BeforeAgentStartEvent,
      ctx: ExtensionContext
    ): Promise<void> => {
      manager.setInstructions(parseInstructions(event.systemPrompt));
      const plan = await detectPlan(event.prompt, ctx.cwd);
      if (plan) manager.setPlan(plan);
      manager.persist();
    };

    pi.events.on(TASK_STATE_EVENT, (value: unknown) => {
      const reason =
        value && typeof value === 'object' && 'reason' in value
          ? String((value as any).reason)
          : undefined;
      manager.setTaskState(value, reason);
      substantial = true;
      manager.persist();
    });

    pi.on('session_start', (_event, ctx) => {
      manager.load(ctx);
      pendingInputs.clear();
      substantial =
        !!manager.get().objective &&
        (!!manager.get().plan || !!activeTask(manager.get().taskState));
    });

    pi.on('session_tree', (_event, ctx) => {
      manager.load(ctx);
      pendingInputs.clear();
    });

    pi.on('input', (event) => {
      if (event.source !== 'interactive' && event.source !== 'rpc') return;
      inputEpoch++;
      manager.bindTrustedInput(event.text, event.source);
      manager.persist();
    });

    pi.on('before_agent_start', async (event, ctx) => {
      await applyPromptMetadata(event, ctx);
      const reminder = manager.takeContinuityReminder();
      if (!reminder) return undefined;
      pi.events.emit(CONTINUITY_EVENT, {
        classes: continuityClasses(manager.get()),
      });
      return {
        message: {
          customType: 'pi-advisor-continuity',
          content: reminder,
          display: false,
          details: { source: 'advisor', agentAttributed: true },
        },
      };
    });

    pi.on('tool_call', (event: ToolCallEvent) => {
      const blocked = gateTaskCall(event, manager);
      if (blocked?.block) return blocked;
      const input = structuredClone(event.input as Record<string, unknown>);
      pendingInputs.set(event.toolCallId, { name: event.toolName, input });
      manager.toolStarted(event.toolCallId, event.toolName, input);
      if (HIGH_SIGNAL_TOOLS.test(event.toolName)) substantial = true;
      activityEpoch++;
      return undefined;
    });

    pi.on('tool_result', (event: ToolResultEvent) => {
      const pending = pendingInputs.get(event.toolCallId);
      pendingInputs.delete(event.toolCallId);
      const output = event.content
        .map((item) => (item.type === 'text' ? item.text : `[${item.type}]`))
        .join('\n');
      const evidence: ToolEvidence = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: pending?.input ?? event.input,
        isError: event.isError,
        outputDigest: digest(output),
        outputPreview: output.replace(/\s+/g, ' ').trim().slice(0, 280),
        finishedAt: Date.now(),
      };
      manager.toolFinished(evidence);
      if (MUTATION_TOOLS.test(event.toolName)) substantial = true;
      manager.persist();
      activityEpoch++;
    });

    pi.on('agent_settled', async (_event, ctx) => {
      if (!substantial || !manager.get().objective) return;
      if (ctx.hasPendingMessages() || Object.keys(manager.get().activeTools).length > 0) return;
      const task = activeTask(manager.get().taskState);
      if (task?.task?.status === 'done' || task?.task?.status === 'cancelled') return;
      const binding = await resolveBinding(ctx);
      if (!binding) {
        if (task)
          emit(
            'Advisor could not run the required different-family completion check; the task remains active.',
            'blocker',
            ctx
          );
        return;
      }
      const startInputEpoch = inputEpoch;
      const startActivityEpoch = activityEpoch;
      const decision = await analyze(
        ctx,
        binding,
        manager.get(),
        'automatic',
        undefined,
        await resolveHostContext(ctx)
      );
      if (
        startInputEpoch !== inputEpoch ||
        startActivityEpoch !== activityEpoch ||
        ctx.hasPendingMessages()
      )
        return;
      manager.markAnalyzed();
      handleDecision(decision, ctx, task?.id);
      manager.persist();
    });

    const handleDecision = (
      decision: AdvisorDecision,
      ctx: ExtensionContext,
      taskId?: string
    ): void => {
      if (decision.objectiveInputAt !== undefined) {
        manager.applyObjectiveInput(decision.objectiveInputAt);
      }
      const message = decision.message?.trim();
      if (decision.verdict === 'PASS') {
        if (taskId) {
          const permit = manager.issuePermit(taskId);
          const continuation = `Completion evidence reconciled. Submit the existing task completion once with its supported evidence. Permit ${permit.slice(0, 12)}.`;
          if (!ctx.hasPendingMessages() && manager.markContinuation(`complete:${permit}`))
            emit(continuation, 'nit', ctx, true);
        } else if (message) {
          emit(message, 'nit', ctx);
        }
        return;
      }
      if (!message || decision.action === 'silent') return;
      const severity: AdvisorSeverity = decision.action === 'blocker' ? 'blocker' : 'concern';
      const wantsContinuation = decision.action === 'continue';
      const signature = digest(`${decision.verdict}\u0000${message}`);
      if (wantsContinuation && !ctx.hasPendingMessages() && manager.markContinuation(signature))
        emit(message, severity, ctx, true);
      else emit(message, severity, ctx);
    };

    pi.on('session_before_compact', () => manager.persist());
    pi.on('session_compact', (_event, ctx) => {
      manager.load(ctx);
      manager.markContinuityPending();
      disposeAdvisorSession();
    });

    pi.on('model_select', () => {
      routeLabel = undefined;
      disposeAdvisorSession();
    });
    pi.on('session_shutdown', () => disposeAdvisorSession());

    pi.registerCommand('advisor', {
      description: 'Ask the always-on execution advisor or inspect current completion status',
      handler: async (args, ctx) => {
        const question = args.trim();
        if (question) {
          inputEpoch++;
          manager.bindTrustedInput(question, 'interactive', Date.now(), false);
        }
        const binding = await resolveBinding(ctx);
        if (!binding) {
          emit(
            statusText(
              manager.get(),
              'UNKNOWN',
              'No eligible different-family Advisor route is available.'
            ),
            'blocker',
            ctx
          );
          return;
        }
        const decision = await analyze(
          ctx,
          binding,
          manager.get(),
          'question',
          question || 'Report current status and completion truth.',
          await resolveHostContext(ctx)
        );
        if (decision.objectiveInputAt !== undefined) {
          manager.applyObjectiveInput(decision.objectiveInputAt);
        }
        const answer =
          decision.message || statusText(manager.get(), decision.verdict, decision.reasoning);
        emit(
          answer,
          decision.verdict === 'GAP'
            ? 'concern'
            : decision.verdict === 'UNKNOWN'
              ? 'blocker'
              : 'nit',
          ctx
        );
      },
    });

    pi.registerMessageRenderer<{ notes: Array<{ note: string; severity: AdvisorSeverity }> }>(
      ADVISOR_MESSAGE,
      (message, _options, theme) => {
        if (!message.details?.notes?.length) return undefined;
        const container = new Container();
        for (const item of message.details.notes) {
          const color =
            item.severity === 'blocker'
              ? 'error'
              : item.severity === 'concern'
                ? 'warning'
                : 'accent';
          container.addChild(
            new Text(
              `${theme.fg(color, `◆ Advisor [${item.severity.toUpperCase()}]`)} ${theme.fg('muted', item.note)}`,
              1,
              0
            )
          );
        }
        return container;
      }
    );

    async function resolveHostContext(ctx: ExtensionContext): Promise<string | undefined> {
      if (!options.resolveContext) return undefined;
      try {
        return await options.resolveContext(ctx, manager.get());
      } catch (error) {
        return `Host context unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  };
}

export default function unavailableDirectEntrypoint(): never {
  throw new Error(
    'pi-advisor requires a host policy adapter; disable the package entrypoint and load createAdvisorExtension(options)'
  );
}

function parseInstructions(systemPrompt: string): InstructionReference[] {
  const refs = new Map<string, InstructionReference>();
  for (const match of systemPrompt.matchAll(/<!-- workspace-source:([^ >]+) -->/g))
    refs.set(match[1], { id: match[1] });
  for (const match of systemPrompt.matchAll(
    /<!-- workspace-source-digest:([^:>]+):sha256:([a-f0-9]{64}) -->/g
  )) {
    refs.set(match[1], { id: match[1], digest: match[2] });
  }
  return [...refs.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function detectPlan(prompt: string, cwd: string): Promise<PlanBinding | undefined> {
  const match = prompt.match(
    /(?:^|[\s@`"'])(\.artifacts\/plans\/[A-Za-z0-9._/-]+\.md)(?=$|[\s`"'])/
  );
  if (!match) return undefined;
  const candidate = resolve(cwd, match[1]);
  const root = resolve(cwd, '.artifacts', 'plans');
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return undefined;
  try {
    const actualRoot = await realpath(root);
    const actual = await realpath(candidate);
    if (actual !== actualRoot && !actual.startsWith(`${actualRoot}${sep}`)) return undefined;
    const content = await readFile(actual, 'utf8');
    return { path: match[1], digest: digest(content) };
  } catch {
    return undefined;
  }
}

function continuityClasses(state: ReturnType<AdvisorStateManager['get']>): string[] {
  return [
    state.objective ? 'objective' : undefined,
    state.plan ? 'plan' : undefined,
    activeTask(state.taskState) ? 'task' : undefined,
    state.blockers.length ? 'blockers' : undefined,
    state.touchedFiles.length ? 'changed files' : undefined,
    state.instructions.length ? 'instructions' : undefined,
  ].filter((value): value is string => !!value);
}

function statusText(
  state: ReturnType<AdvisorStateManager['get']>,
  verdict: AdvisorDecision['verdict'],
  reason: string
): string {
  const task = activeTask(state.taskState);
  return `${verdict}: ${reason}\nObjective: ${state.objective ?? 'unbound'}\nPlan: ${state.plan ? `${state.plan.path} (${state.plan.digest.slice(0, 12)})` : 'none'}\nTask: ${task ? `${task.id} ${task.task.status ?? 'unknown'}` : 'none'}\nBlockers: ${state.blockers.length ? state.blockers.join('; ') : 'none'}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export { CONTINUITY_EVENT };
export type { AdvisorHostOptions, AdvisorModelBinding } from './types.js';
