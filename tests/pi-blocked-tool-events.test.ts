import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { Type } from '@sinclair/typebox';

test('Pi does not emit its after-tool hook or run the tool after a blocked pre-tool result', async () => {
  const piRoot = realpathSync('node_modules/@earendil-works/pi-coding-agent');
  const agentCoreRoot = realpathSync(path.join(piRoot, '..', 'pi-agent-core'));
  const agentCore = await import(
    pathToFileURL(path.join(agentCoreRoot, 'dist/agent-loop.js')).href
  );
  let providerTurns = 0;
  let executions = 0;
  let taskStateEvents = 0;
  let afterToolCalls = 0;
  const tool = {
    name: 'TaskUpdate',
    label: 'TaskUpdate',
    description: 'test task update',
    parameters: Type.Object({ taskId: Type.String(), status: Type.String() }),
    async execute() {
      executions++;
      taskStateEvents++;
      return { content: [{ type: 'text', text: 'completed' }], details: {} };
    },
  };

  const messages = await agentCore.runAgentLoop(
    [{ role: 'user', content: 'complete task', timestamp: 1 }],
    { systemPrompt: '', messages: [], tools: [tool] },
    {
      model: model(),
      convertToLlm: (entries: any[]) => entries,
      beforeToolCall: async () => ({ block: true, reason: 'verification in progress' }),
      afterToolCall: async () => {
        afterToolCalls++;
      },
    },
    async () => {},
    undefined,
    async () => {
      const stream = createAssistantMessageEventStream();
      const message =
        providerTurns++ === 0
          ? assistant(
              [
                {
                  type: 'toolCall',
                  id: 'task-update-1',
                  name: 'TaskUpdate',
                  arguments: { taskId: '1', status: 'completed' },
                },
              ],
              'toolUse'
            )
          : assistant([{ type: 'text', text: 'continuing' }], 'stop');
      stream.push({ type: 'done', reason: message.stopReason as 'toolUse' | 'stop', message });
      return stream;
    }
  );

  const blockedResult = messages.find((message) => message.role === 'toolResult');
  assert.equal(executions, 0);
  assert.equal(taskStateEvents, 0);
  assert.equal(afterToolCalls, 0);
  assert.equal(blockedResult?.role, 'toolResult');
  assert.equal(blockedResult?.isError, true);
});

function assistant(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason']
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-responses',
    provider: 'openai',
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 1,
  };
}

function model(): any {
  return {
    id: 'test',
    name: 'test',
    api: 'openai-responses',
    provider: 'openai',
    baseUrl: 'http://localhost',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
  };
}
