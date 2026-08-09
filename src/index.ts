import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  MessageUpdateEvent,
  ToolCallEvent,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { Container, Text } from '@earendil-works/pi-tui';
import { analyze } from './core/analyzer.js';
import { classifyMutationIntent, gateTaskCall } from './gate.js';
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
import { WatchEngine } from './watch/engine.js';
import type { WatchInput, WatchMatch } from './watch/types.js';

const TASK_STATE_EVENT = 'pi-tasks:state';
const ADVISOR_MESSAGE = 'pi-advisor';
const CONTINUITY_EVENT = 'pi-advisor:continuity-restored';
const HIGH_SIGNAL_TOOLS =
  /^(?:bash|exec|edit|write|task_plan|task_update|task_evidence|task_complete|spawn_agent|create_thread)$/i;
const MUTATION_TOOLS = /^(?:edit|write|patch|apply_patch|delete|rename|move|readSeek_rename)$/i;
const MUTATION_INTENT_TIMEOUT_MS = 10_000;

export function createAdvisorExtension(options: AdvisorHostOptions) {
  return function advisorExtension(pi: ExtensionAPI): void {
    const manager = new AdvisorStateManager(pi);
    const pendingInputs = new Map<string, { name: string; input: Record<string, unknown> }>();
    let inputEpoch = 0;
    let activityEpoch = 0;
    let substantial = false;
    let routeLabel: string | undefined;
    let automaticCheckActive = false;
    let automaticRouteFailure: string | undefined;
    let mutationIntentCache: { inputAt: number; allowed: boolean; reason?: string } | undefined;
    let watcher = options.watchContract
      ? new WatchEngine(options.watchContract, options.matchAst)
      : undefined;
    let watchQueue = Promise.resolve<WatchMatch[]>([]);
    let pendingReminders: WatchMatch[] = [];

    const watch = (input: WatchInput): Promise<WatchMatch[]> => {
      const activeWatcher = watcher;
      if (!activeWatcher) return Promise.resolve([]);
      const run = watchQueue.then(() => activeWatcher.evaluate(input));
      const safeRun = run.catch(() => []);
      watchQueue = safeRun;
      return safeRun.then((matches) => {
        if (watcher !== activeWatcher) return [];
        if (!matches.length) return matches;
        const semantic = matches
          .filter((match) => match.effect === 'semantic')
          .map((match) => ({
            ...match,
            observedEvidenceCount: manager.get().toolEvidence.length,
          }));
        const reminders = matches.filter((match) => match.effect === 'remind');
        if (semantic.length) manager.queueSemanticMatches(semantic);
        if (reminders.length) pendingReminders.push(...reminders);
        manager.setWatchState(watcher!.exportState());
        manager.persist();
        if (matches.some((match) => match.activates)) substantial = true;
        return matches;
      });
    };

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
      const details = {
        notes: [{ note: trimmed, severity }],
        route: routeLabel,
        source: 'advisor',
        agentAttributed: true,
      };
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
      ctx: ExtensionContext,
      reportFailure = true
    ): Promise<AdvisorModelBinding | undefined> => {
      try {
        const binding = await options.resolveModel(ctx);
        routeLabel = binding?.selector;
        if (binding) automaticRouteFailure = undefined;
        return binding;
      } catch (error) {
        routeLabel = undefined;
        const message = `Advisor route failed: ${error instanceof Error ? error.message : String(error)}`;
        if (reportFailure && automaticRouteFailure !== message) {
          automaticRouteFailure = message;
          emit(message, 'blocker', ctx);
        }
        return undefined;
      }
    };

    const mutationGate = async (
      event: ToolCallEvent,
      ctx: ExtensionContext
    ): Promise<{ block: true; terminate: true; reason: string } | undefined> => {
      if (!MUTATION_TOOLS.test(event.toolName)) return undefined;
      const input = manager.get().lastTrustedInput;
      const deterministic = classifyMutationIntent(input?.text);
      if (deterministic === 'authorized') return undefined;
      if (deterministic === 'read-only') {
        return {
          block: true,
          terminate: true,
          reason:
            'The latest real user input requests analysis or discussion, not implementation. Do not modify files until the user explicitly asks for the change.',
        };
      }
      if (input && mutationIntentCache?.inputAt === input.at) {
        return mutationIntentCache.allowed
          ? undefined
          : {
              block: true,
              terminate: true,
              reason:
                mutationIntentCache.reason ??
                'The latest real user input does not clearly authorize implementation.',
            };
      }
      const startInputEpoch = inputEpoch;
      const binding = await resolveBinding(ctx, false);
      if (!binding) {
        return {
          block: true,
          terminate: true,
          reason:
            'Mutation paused because the latest user input is ambiguous and no eligible Advisor route is available to classify it.',
        };
      }
      let decision: AdvisorDecision;
      try {
        const timeout = AbortSignal.timeout(MUTATION_INTENT_TIMEOUT_MS);
        const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
        decision = await analyze(
          ctx,
          binding,
          manager.get(),
          'mutation',
          `${event.toolName} ${JSON.stringify(extractPaths(event.input))}`,
          undefined,
          signal
        );
      } catch (error) {
        return {
          block: true,
          terminate: true,
          reason: `Mutation paused because Advisor intent classification failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (startInputEpoch !== inputEpoch || manager.get().lastTrustedInput?.at !== input?.at) {
        return {
          block: true,
          terminate: true,
          reason: 'Mutation paused because newer user input arrived during intent classification.',
        };
      }
      const allowed = decision.verdict === 'PASS' && decision.confidence >= 0.7;
      const reason =
        decision.message?.trim() ||
        (decision.verdict === 'UNKNOWN'
          ? 'The latest real user input is ambiguous; ask before modifying files.'
          : 'The latest real user input does not authorize implementation.');
      if (input) mutationIntentCache = { inputAt: input.at, allowed, reason };
      return allowed ? undefined : { block: true, terminate: true, reason };
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
      void watch({ source: 'task', content: JSON.stringify(value), snapshot: true });
    });

    pi.on('session_start', (_event, ctx) => {
      manager.load(ctx);
      watcher = options.watchContract
        ? new WatchEngine(options.watchContract, options.matchAst, manager.get().watch)
        : undefined;
      watchQueue = Promise.resolve([]);
      pendingReminders = [];
      pendingInputs.clear();
      automaticRouteFailure = undefined;
      mutationIntentCache = undefined;
      substantial = substantialState(manager.get());
    });

    pi.on('session_tree', (_event, ctx) => {
      manager.load(ctx);
      watcher = options.watchContract
        ? new WatchEngine(options.watchContract, options.matchAst, manager.get().watch)
        : undefined;
      watchQueue = Promise.resolve([]);
      pendingReminders = [];
      pendingInputs.clear();
      automaticRouteFailure = undefined;
      mutationIntentCache = undefined;
      substantial = substantialState(manager.get());
    });

    pi.on('input', (event) => {
      if (event.source !== 'interactive' && event.source !== 'rpc') return;
      inputEpoch++;
      manager.bindTrustedInput(event.text, event.source);
      mutationIntentCache = undefined;
      manager.persist();
      if (!automaticCheckActive || event.streamingBehavior) return;

      // Pi marks the main session idle while awaiting agent_settled handlers. If the
      // user submits during that window, an Advisor continuation can otherwise start
      // between input preflight and dispatch, causing Pi to reject the user message.
      // Cancel the stale check and resubmit once with an explicit lane so the message
      // is valid whether the main session is still idle or has just resumed.
      disposeAdvisorSession();
      const content = event.images?.length
        ? [{ type: 'text' as const, text: event.text }, ...event.images]
        : event.text;
      pi.sendUserMessage(content, { deliverAs: 'steer' });
      return { action: 'handled' as const };
    });

    pi.on('before_agent_start', async (event, ctx) => {
      await applyPromptMetadata(event, ctx);
      void watch({
        source: 'signal',
        content: `instructions:${digest(event.systemPrompt)}`,
        snapshot: true,
      });
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

    pi.on('turn_start', (event) => {
      watcher?.resetTurn();
      void watch({
        source: 'lifecycle',
        content: `turn_start ${event.turnIndex}`,
        snapshot: true,
      });
    });

    pi.on('agent_start', () => {
      void watch({ source: 'lifecycle', content: 'agent_start', snapshot: true });
    });

    pi.on('agent_end', () => {
      void watch({ source: 'lifecycle', content: 'agent_end', snapshot: true });
    });

    pi.on('message_update', (event: MessageUpdateEvent) => {
      const update = event.assistantMessageEvent;
      if (update.type === 'text_delta') {
        void watch({
          source: 'text',
          content: update.delta,
          streamKey: `text:${update.contentIndex}`,
        });
      } else if (update.type === 'thinking_delta') {
        void watch({
          source: 'thinking',
          content: update.delta,
          streamKey: `thinking:${update.contentIndex}`,
        });
      } else if (update.type === 'toolcall_delta') {
        const partial = update.partial.content[update.contentIndex];
        void watch({
          source: 'tool',
          toolName: partial?.type === 'toolCall' ? partial.name : undefined,
          content: update.delta,
          streamKey: `tool:${update.contentIndex}`,
        });
      } else if (update.type === 'toolcall_end') {
        const input = update.toolCall.arguments as Record<string, unknown>;
        void watch({
          source: 'tool',
          toolName: update.toolCall.name,
          content: JSON.stringify(input),
          streamKey: `tool:${update.toolCall.id}`,
          filePaths: extractPaths(input),
          snapshot: true,
        });
      }
    });

    pi.on('message_end', (event) => {
      if (event.message.role !== 'assistant') return;
      const content = Array.isArray(event.message.content) ? event.message.content : [];
      const text = content
        .filter((item: any) => item?.type === 'text')
        .map((item: any) => String(item.text ?? ''))
        .join('\n');
      const thinking = content
        .filter((item: any) => item?.type === 'thinking')
        .map((item: any) => String(item.thinking ?? item.text ?? ''))
        .join('\n');
      if (text)
        void watch({ source: 'text', content: text, streamKey: 'text:final', snapshot: true });
      if (thinking)
        void watch({
          source: 'thinking',
          content: thinking,
          streamKey: 'thinking:final',
          snapshot: true,
        });
    });

    pi.on('turn_end', (event) => {
      const turnWatcher = watcher;
      void watch({
        source: 'lifecycle',
        content: `turn_end ${event.turnIndex}`,
        snapshot: true,
      }).finally(() => {
        if (turnWatcher && watcher === turnWatcher) {
          turnWatcher.finishTurn();
          manager.setWatchState(turnWatcher.exportState());
          manager.persist();
        }
      });
    });

    pi.on('tool_call', async (event: ToolCallEvent, ctx) => {
      const blocked = gateTaskCall(event, manager);
      if (blocked?.block) return blocked;
      const mutationBlocked = await mutationGate(event, ctx);
      if (mutationBlocked) return mutationBlocked;
      const input = structuredClone(event.input as Record<string, unknown>);
      pendingInputs.set(event.toolCallId, { name: event.toolName, input });
      manager.toolStarted(event.toolCallId, event.toolName, input);
      if (HIGH_SIGNAL_TOOLS.test(event.toolName)) substantial = true;
      activityEpoch++;
      void watch({
        source: 'tool',
        toolName: event.toolName,
        content: JSON.stringify(input),
        streamKey: `tool:${event.toolCallId}`,
        filePaths: extractPaths(input),
        snapshot: true,
      });
      return undefined;
    });

    pi.on('tool_result', async (event: ToolResultEvent, ctx) => {
      const pending = pendingInputs.get(event.toolCallId);
      pendingInputs.delete(event.toolCallId);
      const output = event.content
        .map((item) => (item.type === 'text' ? item.text : `[${item.type}]`))
        .join('\n');
      const evidence: ToolEvidence = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: evidenceInput(pending?.input ?? event.input),
        validation: looksLikeValidation(event.toolName, pending?.input ?? event.input),
        isError: event.isError,
        outputDigest: digest(output),
        outputPreview: redactEvidencePreview(output).replace(/\s+/g, ' ').trim().slice(0, 280),
        finishedAt: Date.now(),
      };
      manager.toolFinished(evidence);
      if (MUTATION_TOOLS.test(event.toolName)) substantial = true;
      manager.persist();
      activityEpoch++;
      await watch({
        source: 'tool-result',
        toolName: event.toolName,
        content: `isError:${event.isError}\n${output}`,
        streamKey: `tool-result:${event.toolCallId}`,
        filePaths: extractPaths(pending?.input ?? event.input),
        snapshot: true,
      });
      if (!event.isError && options.resolveToolSnapshots) {
        let snapshots: Awaited<ReturnType<NonNullable<typeof options.resolveToolSnapshots>>> = [];
        try {
          snapshots = await options.resolveToolSnapshots(ctx, {
            toolName: event.toolName,
            input: pending?.input ?? event.input,
            isError: event.isError,
          });
        } catch {
          snapshots = [];
        }
        for (const snapshot of snapshots) {
          await watch({
            source: 'tool',
            toolName: event.toolName,
            content: snapshot.content,
            streamKey: `snapshot:${snapshot.path}`,
            filePaths: [snapshot.path],
            language: snapshot.language,
            snapshot: true,
          });
        }
      }
      for (const reminder of pendingReminders.splice(0))
        emit(reminderText(reminder), reminder.severity, ctx);
    });

    pi.on('agent_settled', async (_event, ctx) => {
      if (!substantial || !manager.get().objective) return;
      if (ctx.hasPendingMessages() || Object.keys(manager.get().activeTools).length > 0) return;
      const task = activeTask(manager.get().taskState);
      if (task?.task?.status === 'done' || task?.task?.status === 'cancelled') return;
      await watch({
        source: 'lifecycle',
        content: `agent_settled substantial:${substantial} task:${task ? 'active' : 'none'} validation:${manager.get().validationAt ? 'present' : 'missing'} mutations:${manager.get().touchedFiles.length}`,
        snapshot: true,
      });
      if (pendingReminders.length && !ctx.hasPendingMessages()) {
        for (const reminder of pendingReminders.splice(0))
          emit(reminderText(reminder), reminder.severity, ctx);
      }
      const pendingSemanticMatches = manager.semanticMatches();
      const semanticMatches = pendingSemanticMatches.filter(
        (match) =>
          match.settledCondition !== 'no-later-tool' ||
          manager.get().toolEvidence.length <= (match.observedEvidenceCount ?? 0)
      );
      if (semanticMatches.length !== pendingSemanticMatches.length) {
        manager.clearSemanticMatches();
        manager.queueSemanticMatches(semanticMatches);
      }
      const completionRequested = manager.get().completionRequested;
      if (!semanticMatches.length && !completionRequested) {
        manager.persist();
        return;
      }
      automaticCheckActive = true;
      try {
        const binding = await resolveBinding(ctx, false);
        if (!binding) {
          const message =
            task || completionRequested
              ? 'Advisor could not run the required different-family completion check; the task remains active.'
              : 'Advisor could not run the different-family semantic check; the deterministic warning remains unresolved.';
          if (automaticRouteFailure !== message) {
            automaticRouteFailure = message;
            emit(message, task || completionRequested ? 'blocker' : 'concern', ctx);
          }
          return;
        }
        const startInputEpoch = inputEpoch;
        const startActivityEpoch = activityEpoch;
        let decision: AdvisorDecision;
        try {
          decision = await analyze(
            ctx,
            binding,
            manager.get(),
            'automatic',
            semanticMatches.length
              ? `Deterministic watch signals:\n${semanticMatches
                  .map(
                    (match) =>
                      `- ${match.ruleId}: ${match.message}${match.provenance?.source ? ` [source: ${match.provenance.source}]` : ''}`
                  )
                  .join('\n')}`
              : completionRequested
                ? `Completion requested for ${completionRequested.taskId}.`
                : undefined,
            await resolveHostContext(ctx)
          );
        } catch (error) {
          if (startInputEpoch === inputEpoch && startActivityEpoch === activityEpoch)
            emit(
              `Advisor check failed: ${error instanceof Error ? error.message : String(error)}`,
              completionRequested ? 'blocker' : 'concern',
              ctx
            );
          return;
        }
        if (
          startInputEpoch !== inputEpoch ||
          startActivityEpoch !== activityEpoch ||
          ctx.hasPendingMessages()
        )
          return;
        manager.clearSemanticMatches();
        manager.markAnalyzed();
        handleDecision(decision, ctx, task?.id);
        manager.persist();
      } finally {
        automaticCheckActive = false;
      }
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
        const completionRequest = manager.get().completionRequested;
        if (taskId && completionRequest?.taskId === taskId) {
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
      watcher = options.watchContract
        ? new WatchEngine(options.watchContract, options.matchAst, manager.get().watch)
        : undefined;
      watchQueue = Promise.resolve([]);
      manager.markContinuityPending();
      void watch({ source: 'lifecycle', content: 'session_compact', snapshot: true });
      disposeAdvisorSession();
    });

    pi.on('model_select', () => {
      routeLabel = undefined;
      automaticRouteFailure = undefined;
      mutationIntentCache = undefined;
      disposeAdvisorSession();
    });
    pi.on('session_shutdown', () => {
      if (watcher) manager.setWatchState(watcher.exportState());
      manager.persist();
      disposeAdvisorSession();
    });

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
        let decision: AdvisorDecision;
        try {
          decision = await analyze(
            ctx,
            binding,
            manager.get(),
            'question',
            question || 'Report current status and completion truth.',
            await resolveHostContext(ctx)
          );
        } catch (error) {
          emit(
            `Advisor question failed: ${error instanceof Error ? error.message : String(error)}`,
            'blocker',
            ctx
          );
          return;
        }
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

function substantialState(state: ReturnType<AdvisorStateManager['get']>): boolean {
  return (
    !!state.objective &&
    (!!state.plan ||
      !!activeTask(state.taskState) ||
      state.touchedFiles.length > 0 ||
      state.toolEvidence.length > 0)
  );
}

function reminderText(match: WatchMatch): string {
  return `[${match.ruleId}] ${match.message}${match.provenance?.source ? ` Source: ${match.provenance.source}.` : ''}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function extractPaths(input: Record<string, unknown>): string[] {
  return [
    ...new Set(
      [input.path, input.file, input.filePath, input.file_path, input.target]
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.replaceAll('\\', '/').replace(/^\.\//, ''))
    ),
  ];
}

function evidenceInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    ['path', 'file', 'filePath', 'file_path', 'target', 'task_id', 'step_id', 'type']
      .filter((key) => typeof input[key] === 'string')
      .map((key) => [key, input[key]])
  );
}

function looksLikeValidation(toolName: string, input: Record<string, unknown>): boolean {
  const command = typeof input.command === 'string' ? input.command : '';
  return /(?:test|check|lint|typecheck|verify|diagnostic|build)/i.test(`${toolName} ${command}`);
}

function redactEvidencePreview(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(
      /\b(authorization|api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^\s"',}]+/gi,
      '$1=[redacted]'
    )
    .replace(/\b(?:sk|dk|ghp|github_pat)-[A-Za-z0-9_-]{8,}\b/g, '[redacted credential]');
}

export { CONTINUITY_EVENT };
export type { AdvisorHostOptions, AdvisorModelBinding } from './types.js';
export { validateWatchContract, WatchEngine } from './watch/engine.js';
export type {
  AstMatchRequest,
  AstMatcher,
  ToolSnapshot,
  WatchContract,
  WatchEffect,
  WatchEngineState,
  WatchInput,
  WatchInterruptMode,
  WatchMatch,
  WatchRule,
  WatchSource,
} from './watch/types.js';
