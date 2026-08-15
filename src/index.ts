import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  MessageUpdateEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { Container, Text } from '@earendil-works/pi-tui';
import { analyze } from './core/analyzer.js';
import { IncrementalAdvisorQueue } from './core/background-queue.js';
import {
  completionCorrection,
  reconcileActiveTools,
  withCompletionAnalysisBudget,
} from './core/completion-control.js';
import {
  redactCrossProviderSecrets,
  sanitizeCrossProvider,
} from './core/cross-provider-sanitizer.js';
import { AdvisorEmissionGuard } from './core/emission-guard.js';
import { TranscriptDeltaRecorder } from './core/transcript-delta.js';
import { disposeAdvisorSession } from './session/client.js';
import { activeTask, AdvisorStateManager } from './state/manager.js';
import type {
  AdvisorAnalysisMode,
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
const EVIDENCE_PREVIEW_LIMIT = 720;
const EVIDENCE_PREVIEW_HEAD = 200;
const ADVISOR_CATCHUP_MS = 30_000;
const HIGH_SIGNAL_TOOLS =
  /^(?:bash|exec|edit|write|TaskCreate|TaskUpdate|task_plan|task_update|task_evidence|task_complete|spawn_agent|create_thread)$/i;
const MUTATION_TOOLS = /^(?:edit|write|patch|apply_patch|delete|rename|move|readSeek_rename)$/i;

type BackgroundUpdate = {
  ctx: ExtensionContext;
  transcript: string;
  wip: boolean;
  inputEpoch: number;
  semanticMatches: WatchMatch[];
};

export function createAdvisorExtension(options: AdvisorHostOptions) {
  return function advisorExtension(pi: ExtensionAPI): void {
    const manager = new AdvisorStateManager(pi);
    const pendingInputs = new Map<string, { name: string; input: Record<string, unknown> }>();
    let inputEpoch = 0;
    let substantial = false;
    let routeLabel: string | undefined;
    let automaticRouteFailure: string | undefined;
    let watcher = options.watchContract
      ? new WatchEngine(options.watchContract, options.matchAst)
      : undefined;
    let watchQueue = Promise.resolve<WatchMatch[]>([]);
    const pendingReminders = new Map<string, WatchMatch[]>();
    const transcript = new TranscriptDeltaRecorder();
    const emissionGuard = new AdvisorEmissionGuard();
    let needsHostPrimeGeneration = -1;

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
        if (semantic.length) manager.queueSemanticMatches(semantic);
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
    ): boolean => {
      const trimmed = message.trim();
      if (!trimmed) return false;
      const signature = digest(`${severity}\u0000${trimmed}`);
      if (!manager.emissionAllowed(signature)) return false;
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
      return true;
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
          emit(message, 'concern', ctx);
        }
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

    const background = new IncrementalAdvisorQueue<BackgroundUpdate>(
      async ({ items, generation, signal }) => {
        const latest = items.at(-1);
        if (!latest || signal.aborted || !background.isCurrent(generation)) return;
        const binding = await resolveBinding(latest.ctx, false);
        if (!binding || signal.aborted || !background.isCurrent(generation)) return;
        const semanticMatches = uniqueMatches(items.flatMap((item) => item.semanticMatches));
        const semanticEscalation = semanticMatches.length > 0;
        const needsHostPrime = needsHostPrimeGeneration === generation;
        const hostContext =
          needsHostPrime || semanticEscalation
            ? await resolveHostContext(latest.ctx, 'automatic', semanticEscalation)
            : undefined;
        if (signal.aborted || !background.isCurrent(generation)) return;
        const decision = await analyze(
          latest.ctx,
          binding,
          structuredClone(manager.get()),
          'automatic',
          semanticMatches.length ? semanticPrompt(semanticMatches) : undefined,
          hostContext,
          signal,
          coalescedTranscript(items)
        );
        if (signal.aborted || !background.isCurrent(generation) || latest.inputEpoch !== inputEpoch)
          return;
        if (needsHostPrimeGeneration === generation) needsHostPrimeGeneration = -1;
        manager.markAnalyzed();
        handleBackgroundDecision(
          { decision, inputEpoch: latest.inputEpoch, wip: latest.wip },
          latest.ctx
        );
        manager.persist();
      }
    );

    const resetBackground = (ctx: ExtensionContext): void => {
      needsHostPrimeGeneration = background.reset();
      transcript.reset();
      emissionGuard.reset();
      disposeAdvisorSession();
      const prime = transcript.prime(ctx);
      if (prime && manager.get().objective) {
        background.enqueue({
          ctx,
          transcript: `[initial bounded prime]\n${prime}`,
          wip: false,
          inputEpoch,
          semanticMatches: [],
        });
      }
    };

    const queuePrimaryDelta = (
      ctx: ExtensionContext,
      wip: boolean,
      semanticMatches: WatchMatch[] = []
    ): void => {
      const delta = transcript.take(ctx);
      if (!delta && !semanticMatches.length) return;
      background.enqueue({
        ctx,
        transcript: delta ?? '[no additional transcript; semantic escalation only]',
        wip,
        inputEpoch,
        semanticMatches,
      });
    };

    const completionGate = async (
      event: ToolCallEvent,
      ctx: ExtensionContext
    ): Promise<ToolCallEventResult | undefined> => {
      if (event.toolName !== 'TaskUpdate') return undefined;
      const input = event.input as Record<string, unknown>;
      if (input.status !== 'completed') return undefined;
      substantial = true;

      const taskId = typeof input.taskId === 'string' ? input.taskId : '';
      const reject = (reason: string): ToolCallEventResult => {
        manager.setCompletionReconciliation(taskId, reason);
        manager.persist();
        return rejectCompletion(reason);
      };
      const task = taskById(manager.get().taskState, taskId);
      if (!task) {
        return reject(
          `Task #${taskId || '?'} is not present in the current task state. Keep it active, refresh the task list, and retry completion.`
        );
      }
      const blockers = openTaskBlockers(manager.get().taskState, task);
      if (blockers.length) {
        return reject(
          `Task #${taskId} is still blocked by ${blockers.map((id) => `#${id}`).join(', ')}. Resolve those tasks before retrying completion.`
        );
      }
      const activeToolIds = reconcileActiveTools(manager.get().activeTools, pendingInputs.keys());
      if (activeToolIds.length > 0) {
        return reject(
          `Task #${taskId} still has active tool work. Let it settle, verify the result, and retry completion.`
        );
      }

      const startInputEpoch = inputEpoch;
      try {
        const decision = await withCompletionAnalysisBudget(
          (completionSignal, catchupMs) =>
            background.runForeground(
              async () => {
                const binding = await resolveBinding(ctx, false);
                if (!binding)
                  throw new Error('no eligible different-family Advisor route is available');
                return analyze(
                  ctx,
                  binding,
                  structuredClone(manager.get()),
                  'completion',
                  `The agent is requesting TaskUpdate status=completed for task #${taskId}: ${sanitizeCrossProvider(String(task.subject ?? ''), 'tool')}. PASS only when the supplied runtime evidence demonstrates the task's stated outcome and acceptance criteria are actually complete. Otherwise identify the single most important missing action or evidence.`,
                  await resolveHostContext(ctx, 'completion', false),
                  completionSignal
                );
              },
              catchupMs,
              completionSignal
            ),
          ctx.signal
        );
        if (startInputEpoch !== inputEpoch) {
          return reject(
            `New user input arrived while task #${taskId} was being checked. Keep it active and reconcile the new instruction before retrying completion.`
          );
        }
        if (decision.verdict === 'PASS' && decision.confidence >= 0.7) {
          manager.clearCompletionReconciliation(taskId);
          manager.persist();
          return undefined;
        }
        const reason = decision.message?.trim() || decision.reasoning.trim();
        return reject(
          completionCorrection(taskId, decision.verdict === 'GAP' ? reason : undefined)
        );
      } catch (error) {
        return reject(completionCorrection(taskId));
      }
    };

    pi.events.on(TASK_STATE_EVENT, (value: unknown) => {
      const completedTasks = completedTaskTransitions(manager.get().taskState, value);
      const reason =
        value && typeof value === 'object' && 'reason' in value
          ? String((value as any).reason)
          : undefined;
      manager.setTaskState(value, reason);
      const source =
        value && typeof value === 'object' && 'source' in value
          ? String((value as any).source)
          : undefined;
      for (const task of source === 'tool' ? [] : completedTasks) {
        manager.queueSemanticMatches([
          {
            ruleId: 'task.completion-reconciliation',
            message: `Task ${task.id} reports done; reconcile the claim against its acceptance criteria and runtime evidence.`,
            severity: 'concern',
            effect: 'semantic',
            activates: true,
            interruptMode: 'never',
            source: 'task',
            signature: digest(`task-completion\u0000${task.id}\u0000${task.updatedAt}`),
            filePaths: [],
            provenance: { owner: 'pi-advisor', source: 'pi-tasks:state' },
          },
        ]);
      }
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
      pendingReminders.clear();
      pendingInputs.clear();
      automaticRouteFailure = undefined;
      substantial = substantialState(manager.get());
      resetBackground(ctx);
    });

    pi.on('session_tree', (_event, ctx) => {
      manager.load(ctx);
      watcher = options.watchContract
        ? new WatchEngine(options.watchContract, options.matchAst, manager.get().watch)
        : undefined;
      watchQueue = Promise.resolve([]);
      pendingReminders.clear();
      pendingInputs.clear();
      automaticRouteFailure = undefined;
      substantial = substantialState(manager.get());
      resetBackground(ctx);
    });

    pi.on('input', (event) => {
      if (event.source !== 'interactive' && event.source !== 'rpc') return;
      inputEpoch++;
      manager.bindTrustedInput(event.text, event.source);
      manager.persist();
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

    pi.on('turn_end', (event, ctx) => {
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
      if (substantial && manager.get().objective) {
        queuePrimaryDelta(ctx, turnIsInProgress(event.message));
      }
    });

    pi.on('tool_call', async (event: ToolCallEvent, ctx) => {
      const completionBlocked = await completionGate(event, ctx);
      if (completionBlocked) return completionBlocked;
      const input = structuredClone(event.input as Record<string, unknown>);
      pendingInputs.set(event.toolCallId, { name: event.toolName, input });
      manager.toolStarted(event.toolCallId, event.toolName, input);
      if (HIGH_SIGNAL_TOOLS.test(event.toolName)) substantial = true;
      void watch({
        source: 'tool',
        toolName: event.toolName,
        content: JSON.stringify(input),
        streamKey: `tool:${event.toolCallId}`,
        filePaths: extractPaths(input),
        snapshot: true,
      }).then((matches) => {
        const reminders = matches.filter((match) => match.effect === 'remind');
        if (reminders.length) pendingReminders.set(event.toolCallId, reminders);
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
        outputPreview: boundedEvidencePreview(output),
        finishedAt: Date.now(),
      };
      manager.toolFinished(evidence);
      if (MUTATION_TOOLS.test(event.toolName)) substantial = true;
      manager.persist();
      const resultMatches = await watch({
        source: 'tool-result',
        toolName: event.toolName,
        content: `isError:${event.isError}\n${output}`,
        streamKey: `tool-result:${event.toolCallId}`,
        filePaths: extractPaths(pending?.input ?? event.input),
        snapshot: true,
      });
      const snapshotMatches: WatchMatch[] = [];
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
          snapshotMatches.push(
            ...(await watch({
              source: 'tool',
              toolName: event.toolName,
              content: snapshot.content,
              streamKey: `snapshot:${snapshot.path}`,
              filePaths: [snapshot.path],
              language: snapshot.language,
              snapshot: true,
            }))
          );
        }
      }
      const reminders = uniqueMatches(
        [
          ...(pendingReminders.get(event.toolCallId) ?? []),
          ...resultMatches,
          ...snapshotMatches,
        ].filter((match) => match.effect === 'remind')
      );
      pendingReminders.delete(event.toolCallId);
      for (const reminder of reminders) emit(reminderText(reminder), reminder.severity, ctx);
    });

    pi.on('agent_settled', async (_event, ctx) => {
      if (!substantial || !manager.get().objective) return;
      if (ctx.hasPendingMessages() || Object.keys(manager.get().activeTools).length > 0) return;
      const task = activeTask(manager.get().taskState);
      await watch({
        source: 'lifecycle',
        content: `agent_settled substantial:${substantial} task:${task ? 'active' : 'none'} validation:${manager.get().validationAt ? 'present' : 'missing'} mutations:${manager.get().touchedFiles.length}`,
        snapshot: true,
      });
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
      if (semanticMatches.length) {
        manager.clearSemanticMatches();
        queuePrimaryDelta(ctx, false, semanticMatches);
      }
      const reconciliation = manager.get().completionReconciliation;
      if (task && reconciliation?.taskId === task.id && !reconciliation.nudged) {
        const message = `Task #${task.id} remains active after a rejected completion: ${reconciliation.reason} Resolve that gap from current evidence and retry TaskUpdate before yielding.`;
        if (!ctx.hasPendingMessages() && emit(message, 'concern', ctx, true)) {
          manager.markCompletionReconciliationNudged(task.id);
          manager.persist();
          return;
        }
      }
      manager.persist();
    });

    const handleBackgroundDecision = (
      completed: { decision: AdvisorDecision; inputEpoch: number; wip: boolean },
      ctx: ExtensionContext
    ): void => {
      if (completed.inputEpoch !== inputEpoch) return;
      const { decision } = completed;
      if (decision.objectiveInputAt !== undefined) {
        manager.applyObjectiveInput(decision.objectiveInputAt);
      }
      const message = decision.message?.trim();
      if (decision.verdict === 'PASS' || decision.verdict === 'UNKNOWN') return;
      if (!message || decision.action === 'silent') return;
      const severity: AdvisorSeverity = decision.action === 'blocker' ? 'blocker' : 'concern';
      if (completed.wip && severity !== 'blocker') return;
      if (decision.confidence < (severity === 'blocker' ? 0.8 : 0.65)) return;
      if (!emissionGuard.accept(message, severity)) return;
      const wantsContinuation = decision.action === 'continue' || severity === 'blocker';
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
      pendingReminders.clear();
      manager.markContinuityPending();
      void watch({ source: 'lifecycle', content: 'session_compact', snapshot: true });
      resetBackground(ctx);
    });

    pi.on('model_select', (_event, ctx) => {
      routeLabel = undefined;
      automaticRouteFailure = undefined;
      pendingReminders.clear();
      resetBackground(ctx);
    });
    pi.on('session_shutdown', () => {
      if (watcher) manager.setWatchState(watcher.exportState());
      manager.persist();
      background.reset();
      disposeAdvisorSession();
    });

    pi.registerCommand('advisor', {
      description: 'Ask the always-on execution advisor or inspect current completion status',
      handler: async (args, ctx) => {
        const question = args.trim();
        if (question) {
          inputEpoch++;
          manager.bindTrustedInput(question, 'interactive', Date.now(), false);
          manager.persist();
        }
        let decision: AdvisorDecision;
        try {
          decision = await background.runForeground(
            async () => {
              const binding = await resolveBinding(ctx);
              if (!binding)
                throw new Error('no eligible different-family Advisor route is available');
              return analyze(
                ctx,
                binding,
                structuredClone(manager.get()),
                'question',
                question || 'Report current status and completion truth.',
                await resolveHostContext(ctx, 'question', false),
                ctx.signal
              );
            },
            ADVISOR_CATCHUP_MS,
            ctx.signal
          );
        } catch (error) {
          emit(
            `Advisor question failed: ${error instanceof Error ? error.message : String(error)}`,
            'concern',
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

    async function resolveHostContext(
      ctx: ExtensionContext,
      mode: AdvisorAnalysisMode,
      semanticEscalation: boolean
    ): Promise<string | undefined> {
      if (!options.resolveContext) return undefined;
      try {
        return sanitizeCrossProvider(
          await options.resolveContext(ctx, manager.get(), mode, semanticEscalation),
          'host'
        );
      } catch (error) {
        return sanitizeCrossProvider(
          `Host context unavailable: ${error instanceof Error ? error.message : String(error)}`,
          'host'
        );
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

function turnIsInProgress(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) && content.some((item) => item?.type === 'toolCall');
}

function uniqueMatches(matches: WatchMatch[]): WatchMatch[] {
  return [...new Map(matches.map((match) => [match.signature, match])).values()];
}

function semanticPrompt(matches: WatchMatch[]): string {
  return `Deterministic watch signals:\n${matches
    .map(
      (match) =>
        `- ${match.ruleId}: ${match.message}${match.provenance?.source ? ` [source: ${match.provenance.source}]` : ''}`
    )
    .join('\n')}`;
}

function coalescedTranscript(items: BackgroundUpdate[]): string {
  const rendered = items
    .map(
      (item, index) =>
        `[incremental update ${index + 1}${item.wip ? ' — in progress, more steps follow' : ''}]\n${item.transcript}`
    )
    .join('\n\n');
  if (rendered.length <= 20_000) return rendered;
  return `${rendered.slice(0, 5_000)}\n… [coalesced background updates bounded] …\n${rendered.slice(-14_950)}`;
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

function completedTaskTransitions(
  previous: unknown,
  current: unknown
): Array<{ id: string; updatedAt: string }> {
  const before = taskRecords(previous);
  if (!before) return [];
  const after = taskRecords(current);
  if (!after) return [];
  const completed: Array<{ id: string; updatedAt: string }> = [];
  for (const [id, value] of Object.entries(after)) {
    if (!value || typeof value !== 'object') continue;
    const task = value as { status?: unknown; updatedAt?: unknown };
    const prior = before[id] as { status?: unknown } | undefined;
    const isCompleted = task.status === 'done' || task.status === 'completed';
    const priorCompleted = prior?.status === 'done' || prior?.status === 'completed';
    if (!isCompleted || priorCompleted) continue;
    completed.push({
      id,
      updatedAt: typeof task.updatedAt === 'string' ? task.updatedAt : String(Date.now()),
    });
  }
  return completed;
}

function taskRecords(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const event = value as { state?: unknown; tasks?: unknown };
  const state = event.state ?? event;
  if (!state || typeof state !== 'object') return undefined;
  const tasks = (state as { tasks?: unknown }).tasks;
  if (Array.isArray(tasks)) {
    return Object.fromEntries(
      tasks
        .filter((task): task is Record<string, unknown> => !!task && typeof task === 'object')
        .filter((task) => typeof task.id === 'string')
        .map((task) => [String(task.id), task])
    );
  }
  return tasks && typeof tasks === 'object' ? (tasks as Record<string, unknown>) : undefined;
}

function taskById(value: unknown, id: string): Record<string, any> | undefined {
  const task = taskRecords(value)?.[id];
  return task && typeof task === 'object' ? (task as Record<string, any>) : undefined;
}

function openTaskBlockers(value: unknown, task: Record<string, any>): string[] {
  const records = taskRecords(value) ?? {};
  const blockedBy = Array.isArray(task.blockedBy) ? task.blockedBy : [];
  return blockedBy.filter((id): id is string => {
    if (typeof id !== 'string') return false;
    const blocker = records[id] as { status?: unknown } | undefined;
    return !blocker || (blocker.status !== 'completed' && blocker.status !== 'done');
  });
}

function rejectCompletion(reason: string): ToolCallEventResult {
  return { block: true, reason };
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
  return redactCrossProviderSecrets(value);
}

function boundedEvidencePreview(value: string): string {
  const compact = redactEvidencePreview(value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, ''))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && /[\p{L}\p{N}]/u.test(line))
    .join(' ⏎ ');

  if (compact.length <= EVIDENCE_PREVIEW_LIMIT) return compact;
  const tailLength = EVIDENCE_PREVIEW_LIMIT - EVIDENCE_PREVIEW_HEAD - 3;
  return `${compact.slice(0, EVIDENCE_PREVIEW_HEAD)} … ${compact.slice(-tailLength)}`;
}

export { CONTINUITY_EVENT };
export type { AdvisorAnalysisMode, AdvisorHostOptions, AdvisorModelBinding } from './types.js';
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
