/**
 * SupervisorSession - reusable session for a single supervision goal.
 * Maintains context window across multiple analyses for token efficiency.
 */

import {
  createAgentSession,
  createFindTool,
  createGrepTool,
  createReadTool,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { CreateAgentSessionOptions, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export class SupervisorSession {
  private session: Awaited<ReturnType<typeof createAgentSession>>['session'] | null = null;
  private model: any = null;
  private systemPrompt: string = '';
  private toolsEnabled: boolean | null = null;
  private startupGeneration = 0;

  constructor(private readonly createSession: typeof createAgentSession = createAgentSession) {}

  async ensureStarted(
    ctx: ExtensionContext,
    provider: string,
    modelId: string,
    systemPrompt: string,
    effort: string,
    toolsEnabled = true
  ): Promise<boolean> {
    // If model or system prompt changed, need new session
    const newModel = ctx.modelRegistry.find(provider, modelId);
    if (!newModel) return false;

    if (
      this.session &&
      this.model === newModel &&
      this.systemPrompt === systemPrompt &&
      this.toolsEnabled === toolsEnabled
    ) {
      // Session reusable
      return true;
    }

    this.dispose();
    const generation = this.startupGeneration;

    const loader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPromptOverride: () => systemPrompt,
    });
    await loader.reload();
    if (generation !== this.startupGeneration) return false;

    try {
      const result = await this.createSession({
        cwd: ctx.cwd,
        sessionManager: SessionManager.inMemory(),
        agentDir: getAgentDir(),
        model: newModel,
        thinkingLevel: effort as NonNullable<CreateAgentSessionOptions['thinkingLevel']>,
        tools: advisorBuiltInTools(toolsEnabled),
        customTools: toolsEnabled ? advisorTools(ctx.cwd) : [],
        resourceLoader: loader,
      });
      if (generation !== this.startupGeneration) {
        result.session.dispose();
        return false;
      }
      this.session = result.session;
      this.model = newModel;
      this.systemPrompt = systemPrompt;
      this.toolsEnabled = toolsEnabled;
      return true;
    } catch {
      return false;
    }
  }

  async prompt(
    userPrompt: string,
    signal?: AbortSignal,
    onDelta?: (accumulated: string) => void
  ): Promise<string | null> {
    const session = this.session;
    if (!session) return null;
    if (signal?.aborted) {
      this.discard(session);
      return null;
    }

    let responseText = '';
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        responseText += event.assistantMessageEvent.delta;
        onDelta?.(responseText);
      }
    });
    let rejectAbort: ((error: Error) => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = (): void => {
      this.discard(session);
      rejectAbort?.(new Error('advisor prompt aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      await (signal
        ? Promise.race([session.prompt(userPrompt), aborted])
        : session.prompt(userPrompt));
    } catch {
      this.discard(session);
      return null;
    } finally {
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
    }

    return responseText;
  }

  dispose(): void {
    this.startupGeneration++;
    if (this.session) {
      this.session.dispose();
      this.session = null;
    }
    this.model = null;
    this.systemPrompt = '';
    this.toolsEnabled = null;
  }

  private discard(session: NonNullable<SupervisorSession['session']>): void {
    if (this.session !== session) return;
    this.dispose();
  }
}

export function advisorBuiltInTools(toolsEnabled: boolean): Array<'read' | 'grep' | 'find'> {
  return toolsEnabled ? ['read', 'grep', 'find'] : [];
}

function advisorTools(cwd: string) {
  return [createReadTool(cwd), createGrepTool(cwd), createFindTool(cwd)].map((tool) =>
    constrainToRoot(tool, cwd)
  );
}

function constrainToRoot<T extends { execute: (...args: any[]) => Promise<any> }>(
  tool: T,
  cwd: string
): T {
  const execute = tool.execute.bind(tool);
  tool.execute = (async (...args: Parameters<T['execute']>) => {
    const input = args[1] as { path?: unknown } | undefined;
    await assertWithinRoot(cwd, typeof input?.path === 'string' ? input.path : '.');
    return execute(...args);
  }) as T['execute'];
  return tool;
}

async function assertWithinRoot(cwd: string, requestedPath: string): Promise<void> {
  const lexicalRoot = resolve(cwd);
  const root = await realpath(cwd);
  const candidate = resolve(lexicalRoot, requestedPath);
  if (!within(candidate, lexicalRoot) && !within(candidate, root)) {
    throw new Error('Advisor read-only tools are restricted to the active workspace');
  }
  const actual = await realpath(candidate);
  if (!within(actual, root)) {
    throw new Error('Advisor read-only tools cannot follow paths outside the active workspace');
  }
}

function within(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}
