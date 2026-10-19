import assert from 'node:assert/strict';
import test from 'node:test';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';
import { createInitialContext } from '../../../packages/runtime/src/index.js';
import {
  IntentModelDecisionAdapter,
  JevDecisionAdapter,
  ModelGateway,
  ModelProfileRegistry,
  type DecisionRequest,
  type ModelProvider
} from '../../../packages/decision/src/index.js';
import { buildFallbackUserPrompt, buildResponseUserPrompt, buildSemanticUserPrompt } from '../../../examples/agent-sandbox/src/models/model-input-transport.js';

function request(): DecisionRequest {
  return {
    decisionType: 'function.select',
    decisionVersion: 'runtime.v1',
    threshold: 0.7,
    candidates: [{ candidateId: 'ticket.create', priority: 1, specificity: 1 }]
  };
}

function profiles() {
  return new ModelProfileRegistry([
    {
      schemaVersion: 'iar.model-profile/v1', profileId: 'jev-primary', profileVersion: '1.0.0', role: 'function.select',
      decisionBackend: 'jev', provider: 'jev-provider', modelId: 'jev', modelVersion: '1', timeoutMs: 1000,
      retryPolicy: { maxAttempts: 1, backoffMs: 0, retryOn: ['timeout'] }, structuredOutput: { enabled: true, schemaId: 'iar.decision/v1' }
    },
    {
      schemaVersion: 'iar.model-profile/v1', profileId: 'intent-primary', profileVersion: '1.0.0', role: 'function.select',
      decisionBackend: 'intent-model', provider: 'intent-provider', modelId: 'intent', modelVersion: '1', timeoutMs: 1000,
      retryPolicy: { maxAttempts: 1, backoffMs: 0, retryOn: ['timeout'] }, structuredOutput: { enabled: true, schemaId: 'iar.decision/v1' }
    }
  ]);
}

function decisionResult(input: unknown): Record<string, unknown> {
  const record = input as { request?: DecisionRequest; decisionType?: string; decisionVersion?: string; candidates?: Array<{ candidateId: string }> };
  const source = record.request ?? record;
  const candidates = source.candidates ?? [{ candidateId: 'ticket.create' }];
  return {
    schemaVersion: 'iar.decision/v1', decisionType: source.decisionType, decisionVersion: source.decisionVersion,
    status: 'choice', choice: candidates[0]?.candidateId, score: 0.99, reasonCode: 'test', candidateIds: candidates.map((item) => item.candidateId)
  };
}

test('model prompts carry the current message and structured context, never raw recent messages', () => {
  const context = createInitialContext('run-context');
  context.facts = {
    'ticket.create.ticketId': {
      value: 'ticket-001', status: 'verified', sourceEventId: 'event-001', functionId: 'ticket.create', pluginId: 'ticket-create-v1', field: 'ticketId'
    }
  };
  const semantic = buildSemanticUserPrompt({ text: '告诉我刚才的编号', behaviorContext: context });
  const response = buildResponseUserPrompt({ userMessage: '告诉我刚才的编号', behaviorContext: context, functionId: 'ticket.create', pluginId: 'ticket-create-v1', actionStatus: 'succeeded', actionOutput: { receipt: 'ticket-001' } });
  const fallback = buildFallbackUserPrompt({ userMessage: '告诉我刚才的编号', behaviorContext: context, reasonCode: 'function_noul' }, ['ticket.create']);
  for (const prompt of [semantic, response, fallback]) {
    assert.match(prompt, /ticket-001/);
    assert.doesNotMatch(prompt, /recentMessages|最近对话|原始聊天|用户私密标题/);
    assert.match(prompt, /结构化|事实|澄清/);
  }
  assert.match(semantic, /告诉我刚才的编号/);
});

test('JEV and Intent Model receive the same structured context without changing the decision contract', async () => {
  const context = createInitialContext('run-context');
  context.facts = {
    'ticket.create.ticketId': {
      value: 'ticket-002', status: 'verified', sourceEventId: 'event-002', functionId: 'ticket.create', pluginId: 'ticket-create-v1', field: 'ticketId'
    }
  };
  const calls: Array<{ backend: string; input: Record<string, unknown> }> = [];
  const provider: ModelProvider = { complete: async (input) => {
    calls.push({ backend: input.profile.decisionBackend ?? 'jev', input: input.input as Record<string, unknown> });
    return decisionResult(input.input);
  } };
  const registry = profiles();
  const gateway = new ModelGateway({ registry, providers: { 'jev-provider': provider, 'intent-provider': provider } });
  const invocation = { traceId: 'trace-context', runId: 'run-context', request: request(), currentMessage: '告诉我刚才的工单编号', behaviorContext: context };
  const jev = await new JevDecisionAdapter(gateway, 'function.select').decide(invocation);
  const intent = await new IntentModelDecisionAdapter(gateway, 'function.select').decide(invocation);
  assert.equal(jev.ok, true);
  assert.equal(intent.ok, true);
  assert.deepEqual(calls[0]?.input.behaviorContext, context);
  assert.deepEqual(calls[1]?.input.behaviorContext, context);
  assert.equal(calls[0]?.input.currentMessage, '告诉我刚才的工单编号');
  assert.equal(calls[1]?.input.currentMessage, '告诉我刚才的工单编号');
  assert.deepEqual((calls[0]?.input.candidates as unknown as DecisionRequest['candidates']), request().candidates);
  assert.equal(calls[0]?.input.request, undefined);
  assert.deepEqual((calls[1]?.input.request as unknown as { candidateIds: string[] })?.candidateIds, ['ticket.create']);
});

test('normal and streaming session calls use the live structured context after a successful action', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.IAR_LLM_API_KEY;
  const originalUrl = process.env.IAR_LLM_BASE_URL;
  const prompts: string[] = [];
  process.env.IAR_LLM_API_KEY = 'test-key';
  process.env.IAR_LLM_BASE_URL = 'http://127.0.0.1:1';
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(String(options?.body)) as { stream?: boolean; messages?: Array<{ role: string; content: string }> };
    const userPrompt = payload.messages?.[1]?.content ?? '';
    prompts.push(userPrompt);
    const semantic = payload.messages?.[0]?.content.includes('Semantic Extractor') === true;
    if (semantic) {
      const frame = userPrompt.includes('帮我创建')
        ? { schemaVersion: 'iar.semantic-frame/v1', intent: 'ticket.create', slots: { operation: 'create' }, references: [], confidence: 0.99 }
        : { schemaVersion: 'iar.semantic-frame/v1', intent: 'unknown', slots: {}, references: [], confidence: 0.2 };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(frame) } }] }), { status: 200 });
    }
    if (payload.stream === true) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"已根据结构化事实回答"}}]}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ schemaVersion: 'iar.response/v1', text: '已根据结构化事实回答' }) } }] }), { status: 200 });
  };
  const session = new IarSandboxSession({ mode: 'brain' });
  try {
    assert.equal((await session.turn('帮我创建工单，网络很慢')).status, 'awaiting_confirmation');
    assert.equal((await session.confirm(true)).status, 'executed');
    const state = await session.state();
    const ticketId = state.context.facts?.['ticket.create.ticketId']?.value;
    assert.equal(typeof ticketId, 'string');
    assert.equal((await session.turn('告诉我刚才的工单编号')).status, 'clarification');
    assert.equal((await session.turnStreamed('还是告诉我这个编号', () => {})).status, 'clarification');
    assert.ok(prompts.some((prompt) => prompt.includes(`<behavior_context>`) && prompt.includes(String(ticketId))));
    assert.ok(prompts.filter((prompt) => prompt.includes(String(ticketId))).every((prompt) => !prompt.includes('最近对话')));
  } finally {
    session.dispose();
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.IAR_LLM_API_KEY; else process.env.IAR_LLM_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.IAR_LLM_BASE_URL; else process.env.IAR_LLM_BASE_URL = originalUrl;
  }
});

test('scripted semantic fallback answers a verified follow-up without repeating the action', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    assert.equal((await session.turn('帮我创建工单，网络很慢')).status, 'awaiting_confirmation');
    assert.equal((await session.confirm(true)).status, 'executed');
    const before = await session.state();
    const ticketId = before.context.facts?.['ticket.create.ticketId']?.value;
    assert.equal(typeof ticketId, 'string');
    const followUp = await session.turn('告诉我刚才的工单单号');
    const after = await session.state();
    assert.equal(followUp.status, 'clarification');
    assert.match(followUp.reply, new RegExp(String(ticketId)));
    assert.equal(after.stats.eventCount, before.stats.eventCount);
    assert.equal(after.pending, null);
  } finally {
    session.dispose();
  }
});
