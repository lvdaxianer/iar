import assert from 'node:assert/strict';
import test from 'node:test';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';
import { InMemorySnapshotStore } from '@iar/storage';
import { createInitialContext } from '@iar/runtime';
import {
  IntentModelDecisionAdapter,
  JevDecisionAdapter,
  ModelGateway,
  ModelProfileRegistry,
  type DecisionRequest,
  type ModelProvider
} from '@iar/runtime';
import { buildFallbackUserPrompt, buildResponseUserPrompt, buildSemanticUserPrompt } from '../../../examples/agent-sandbox/src/models/model-input-transport.js';
import { ResponseGeneratorAdapter } from '@iar/runtime';
import { PluginHost } from '@iar/plugins';
import type { ActionType } from '@iar/contracts';
import { SEMANTIC_SYSTEM_PROMPT } from '../../../examples/agent-sandbox/src/models/model-input-transport.js';
import { pluginPackage } from '../../contract/fixtures/plugin-package.js';

function descriptorManifest(pluginId: string, functionId: string, actionTypes: ActionType[] = ['query']) {
  return pluginPackage({
    apiVersion: 'iar.dev/v1', schemaVersion: 'iar.plugin-manifest/v1', pluginId, pluginKind: 'business', scope: 'plugin',
    version: '1.0.0', description: `descriptor-${pluginId}`, capabilities: ['read.capability'], lifecycle: { entrypoint: './handler.js' },
    policy: { riskLevel: 'low', requiresConfirmation: false, allowedCapabilities: ['read.capability'] }, dependencies: []
  }, functionId, { actionTypes });
}

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
    },
    {
      schemaVersion: 'iar.model-profile/v1', profileId: 'response-primary', profileVersion: '1.0.0', role: 'response.generate',
      provider: 'intent-provider', modelId: 'response', modelVersion: '1', timeoutMs: 1000,
      retryPolicy: { maxAttempts: 1, backoffMs: 0, retryOn: ['timeout'] }, structuredOutput: { enabled: true, schemaId: 'iar.response/v1' }
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

test('语义与回复模型接收当前问题、结构化上下文和有界最近消息', () => {
  const context = createInitialContext('run-context');
  context.factHistory = {
    records: [{ recordId: 'fact-001', sequence: 1, sourceEventId: 'event-001', functionId: 'function.visible', pluginId: 'plugin.visible', values: { ticketId: 'ticket-001' }, createdAt: '2026-10-20T00:00:00.000Z' }],
    focusRecordId: 'fact-001'
  };
  const semantic = buildSemanticUserPrompt({ text: '告诉我刚才的编号', behaviorContext: context });
  const functionDescriptors = [{ candidateKey: 'candidate-opaque', functionId: 'function.visible', pluginId: 'plugin.visible', description: '动态能力描述', actionTypes: ['query'] }];
  const response = buildResponseUserPrompt({ userMessage: '告诉我刚才的编号', behaviorContext: context, functionId: 'ticket.create', pluginId: 'ticket-create-v1', actionStatus: 'succeeded', actionOutput: { receipt: 'ticket-001' }, functionDescriptors });
  const fallback = buildFallbackUserPrompt({ userMessage: '告诉我刚才的编号', behaviorContext: context, reasonCode: 'function_noul', recentMessages: [{ role: 'user', text: '上一轮问题' }] }, functionDescriptors);
  for (const prompt of [semantic, response, fallback]) {
    assert.match(prompt, /ticket-001/);
  assert.match(prompt, /最近有限/);
    assert.match(prompt, /结构化|事实|澄清/);
  }
  assert.match(semantic, /告诉我刚才的编号/);
  assert.match(response, /动态能力描述/);
  assert.match(fallback, /candidate-opaque/);
});

test('历史关系使用不透明记录并与动态能力和最近消息同时进入模型输入', () => {
  const context = createInitialContext('run-relation-prompt');
  context.factHistory = {
    records: [{ recordId: 'opaque-record-1', sequence: 1, sourceEventId: 'event-1', functionId: 'function.dynamic', pluginId: 'plugin.dynamic', values: { dynamicField: 'trusted-value' }, createdAt: '2026-10-20T00:00:00.000Z' }],
    focusRecordId: 'opaque-record-1'
  };
  const input = {
    userMessage: '告诉我上一个',
    text: '告诉我上一个',
    behaviorContext: context,
    recentMessages: [{ role: 'user', text: '上一条原文' }],
    resolvedReferences: [{ text: '上一个', record: context.factHistory.records[0] }],
    referenceCandidates: [context.factHistory.records[0]],
    functionDescriptors: [{ candidateKey: 'candidate-dynamic', functionId: 'function.dynamic', pluginId: 'plugin.dynamic', description: '动态能力', actionTypes: ['query'] }]
  };
  const semantic = buildSemanticUserPrompt(input);
  const response = buildResponseUserPrompt(input);
  const fallback = buildFallbackUserPrompt({ ...input, reasonCode: 'reference_unresolved', availableFunctions: input.functionDescriptors }, input.functionDescriptors);
  for (const prompt of [semantic, response, fallback]) {
    assert.match(prompt, /opaque-record-1/);
    assert.match(prompt, /trusted-value/);
    assert.match(prompt, /上一条原文/);
    assert.match(prompt, /candidate-dynamic/);
  }
  assert.match(response, /运行时保留的历史引用候选/);
  assert.match(fallback, /运行时保留的历史引用候选/);
  assert.match(SEMANTIC_SYSTEM_PROMPT, /iar\.semantic-frame\/v2/);
  assert.match(SEMANTIC_SYSTEM_PROMPT, /previous/);
  assert.doesNotMatch(SEMANTIC_SYSTEM_PROMPT, /resolvedTo/);
});

test('PluginHost 只投影当前启用且授权的通用描述，并使用不透明候选键', () => {
  const host = new PluginHost();
  assert.equal(host.install(descriptorManifest('plugin.visible', 'function.visible')).ok, true);
  assert.equal(host.install(descriptorManifest('plugin.hidden', 'function.hidden')).ok, true);
  assert.equal(host.enable('plugin.visible').ok, true);
  assert.equal(host.enable('plugin.hidden').ok, true);
  const descriptors = host.descriptors({ authorize: (record) => record.manifest.pluginId === 'plugin.visible' });
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0]?.functionId, 'function.visible');
  assert.equal(descriptors[0]?.pluginId, 'plugin.visible');
  assert.notEqual(descriptors[0]?.candidateKey, 'plugin.visible');
  assert.notEqual(descriptors[0]?.candidateKey, 'function.visible');
  assert.deepEqual(descriptors[0]?.operationMetadata.actionTypes, ['query']);
});

test('共享语义系统提示词不内置业务功能目录，描述由调用输入提供', () => {
  assert.doesNotMatch(SEMANTIC_SYSTEM_PROMPT, /knowledge\.query|ticket\.create|human\.transfer/);
  const prompt = buildSemanticUserPrompt({
    text: '请帮我处理这个问题',
    behaviorContext: createInitialContext('run-descriptor'),
    functionDescriptors: [{ candidateKey: 'candidate-opaque', functionId: 'function.visible', pluginId: 'plugin.visible', description: '动态能力描述', actionTypes: ['query'] }]
  });
  assert.match(prompt, /candidate-opaque/);
  assert.match(prompt, /动态能力描述/);
});

test('JEV and Intent Model receive the same structured context without changing the decision contract', async () => {
  const context = createInitialContext('run-context');
  context.factHistory = {
    records: [{ recordId: 'fact-002', sequence: 1, sourceEventId: 'event-002', functionId: 'function.visible', pluginId: 'plugin.visible', values: { ticketId: 'ticket-002' }, createdAt: '2026-10-20T00:00:00.000Z' }],
    focusRecordId: 'fact-002'
  };
  const calls: Array<{ backend: string; input: Record<string, unknown> }> = [];
  const provider: ModelProvider = { complete: async (input) => {
    calls.push({ backend: input.profile.decisionBackend ?? 'jev', input: input.input as Record<string, unknown> });
    return decisionResult(input.input);
  } };
  const registry = profiles();
  const gateway = new ModelGateway({ registry, providers: { 'jev-provider': provider, 'intent-provider': provider } });
  const recentMessages = [{ role: 'user', text: '之前的问题' }, { role: 'assistant', text: '之前的回答' }];
  const invocation = { traceId: 'trace-context', runId: 'run-context', request: request(), currentMessage: '告诉我刚才的工单编号', behaviorContext: context, recentMessages };
  const jev = await new JevDecisionAdapter(gateway, 'function.select').decide(invocation);
  const intent = await new IntentModelDecisionAdapter(gateway, 'function.select').decide(invocation);
  assert.equal(jev.ok, true);
  assert.equal(intent.ok, true);
  assert.deepEqual(calls[0]?.input.behaviorContext, context);
  assert.deepEqual(calls[1]?.input.behaviorContext, context);
  assert.equal(calls[0]?.input.currentMessage, '告诉我刚才的工单编号');
  assert.equal(calls[1]?.input.currentMessage, '告诉我刚才的工单编号');
  assert.deepEqual(calls[0]?.input.recentMessages, recentMessages);
  assert.deepEqual(calls[1]?.input.recentMessages, recentMessages);
  assert.deepEqual((calls[0]?.input.candidates as unknown as DecisionRequest['candidates']), request().candidates);
  assert.equal(calls[0]?.input.request, undefined);
  assert.deepEqual((calls[1]?.input.request as unknown as { candidateIds: string[] })?.candidateIds, ['ticket.create']);
});

test('决策模型拒绝超过窗口上限的最近消息输入', async () => {
  const provider: ModelProvider = { complete: async (input) => decisionResult(input.input) };
  const gateway = new ModelGateway({ registry: profiles(), providers: { 'jev-provider': provider } });
  const result = await new JevDecisionAdapter(gateway, 'function.select').decide({
    traceId: 'trace-bounded-messages', runId: 'run-bounded-messages', request: request(),
    recentMessages: Array.from({ length: 21 }, (_, index) => ({ role: 'user', text: String(index) }))
  });
  assert.equal(result.ok, false);
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
      const frame = userPrompt.startsWith('当前用户问题：帮我创建')
        ? { schemaVersion: 'iar.semantic-frame/v1', intent: 'ticket.create', action: 'create', slots: { operation: 'create' }, references: [], confidence: 0.99 }
        : { schemaVersion: 'iar.semantic-frame/v1', intent: 'unknown', slots: {}, references: [], confidence: 0.2 };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(frame) } }] }), { status: 200 });
    }
    if (payload.stream === true) {
      const content = JSON.stringify({ schemaVersion: 'iar.response/v1', text: '请告诉我你要查询哪一个对象。', clarification: { kind: 'selection', status: 'required', options: [{ key: '1', label: '第一个对象' }, { key: '2', label: '第二个对象' }] } });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
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
    const ticketId = state.context.factHistory?.records.at(-1)?.values.ticketId;
    assert.equal(typeof ticketId, 'string');
    assert.equal((await session.turn('告诉我刚才的工单编号')).status, 'clarification');
    assert.equal((await session.turnStreamed('还是告诉我这个编号', () => {})).status, 'clarification');
    assert.deepEqual((await session.state()).context.pending.options, [{ key: '1', label: '第一个对象' }, { key: '2', label: '第二个对象' }]);
    assert.ok(prompts.some((prompt) => prompt.includes(`<behavior_context>`) && prompt.includes(String(ticketId))));
    assert.ok(prompts.filter((prompt) => prompt.includes(String(ticketId))).every((prompt) => prompt.includes('最近有限')));
    assert.ok(prompts.filter((prompt) => prompt.includes('最近有限')).length >= 2);
    assert.ok(prompts.some((prompt) => prompt.includes('<function_descriptors>')));
    assert.ok(prompts.some((prompt) => prompt.includes('当前能力描述')));
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
    const ticketId = before.context.factHistory?.records.at(-1)?.values.ticketId;
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

test('scripted fallback resolves the previous fact record instead of returning the whole chain', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    assert.equal((await session.turn('帮我创建工单，网络很慢')).status, 'awaiting_confirmation');
    assert.equal((await session.confirm(true)).status, 'executed');
    assert.equal((await session.turn('再帮我创建一张工单，邮箱收不到邮件')).status, 'awaiting_confirmation');
    assert.equal((await session.confirm(true)).status, 'executed');

    const state = await session.state();
    const records = state.context.factHistory?.records ?? [];
    assert.equal(records.length, 2);
    const first = records[0]?.values.ticketId;
    const second = records[1]?.values.ticketId;
    assert.equal(typeof first, 'string');
    assert.equal(typeof second, 'string');
    assert.notEqual(first, second);

    const followUp = await session.turn('告诉我这个的上一个工单编号');
    assert.equal(followUp.status, 'clarification');
    assert.match(followUp.reply, new RegExp(String(first)));
    assert.doesNotMatch(followUp.reply, new RegExp(String(second)));
  } finally {
    session.dispose();
  }
});

test('response.generate accepts bounded clarification metadata for generic pending input', async () => {
  const registry = profiles();
  const provider: ModelProvider = {
    complete: async () => ({
      schemaVersion: 'iar.response/v1',
      text: '请告诉我你要查询哪一个对象。',
      clarification: {
        kind: 'selection',
        status: 'required',
        options: [{ key: '1', label: '第一个对象' }, { key: '2', label: '第二个对象' }]
      }
    })
  };
  const gateway = new ModelGateway({ registry, providers: { 'intent-provider': provider } });
  const result = await new ResponseGeneratorAdapter(gateway).generate({ traceId: 'trace-clarification', runId: 'run-clarification', input: { userMessage: '告诉我第几位' } });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual((result.value as GeneratedResponseWithClarification).clarification?.options, [{ key: '1', label: '第一个对象' }, { key: '2', label: '第二个对象' }]);
});

test('response.generate rejects malformed clarification metadata without producing pending state', async () => {
  const provider: ModelProvider = {
    complete: async () => ({
      schemaVersion: 'iar.response/v1',
      text: '请补充信息。',
      clarification: { kind: 'selection', status: 'required', options: [{ key: '1', label: '第一项' }, { key: '1', label: '重复项' }] }
    })
  };
  const gateway = new ModelGateway({ registry: profiles(), providers: { 'intent-provider': provider } });
  const result = await new ResponseGeneratorAdapter(gateway).generate({ traceId: 'trace-invalid-clarification', runId: 'run-invalid-clarification', input: { userMessage: '不确定' } });
  assert.equal(result.ok, false);
});

test('scripted fallback answers a generic ranking follow-up from structured facts', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    assert.equal((await session.turn('我想转人工')).status, 'awaiting_confirmation');
    assert.equal((await session.confirm(true)).status, 'executed');
    const followUp = await session.turn('我现在排第几位');
    assert.equal(followUp.status, 'clarification');
    assert.match(followUp.reply, /3/);
  } finally {
    session.dispose();
  }
});

test('model clarification options are projected, asynchronously snapshotted and restored for the next short input', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.IAR_LLM_API_KEY;
  const originalUrl = process.env.IAR_LLM_BASE_URL;
  const prompts: string[] = [];
  let responseCount = 0;
  process.env.IAR_LLM_API_KEY = 'test-key';
  process.env.IAR_LLM_BASE_URL = 'http://127.0.0.1:1';
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(String(options?.body)) as { messages?: Array<{ role: string; content: string }> };
    const system = payload.messages?.[0]?.content ?? '';
    const user = payload.messages?.[1]?.content ?? '';
    prompts.push(user);
    if (system.includes('Semantic Extractor')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ schemaVersion: 'iar.semantic-frame/v1', intent: 'unknown', action: 'unknown', slots: {}, references: [], confidence: 0.2 }) } }] }), { status: 200 });
    }
    responseCount += 1;
    const response = responseCount === 1
      ? { schemaVersion: 'iar.response/v1', text: '请告诉我你要查询哪一个对象。', clarification: { kind: 'selection', status: 'required', options: [{ key: '1', label: '第一个对象' }, { key: '2', label: '第二个对象' }] } }
      : { schemaVersion: 'iar.response/v1', text: '已根据你选择的对象继续处理。' };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }), { status: 200 });
  };
  const snapshotStore = new InMemorySnapshotStore();
  const first = new IarSandboxSession({ mode: 'brain', sessionId: 'clarification-session', snapshotStore });
  try {
    assert.equal((await first.turn('我想知道排队位置')).status, 'clarification');
    const state = await first.state();
    assert.deepEqual(state.context.pending.options, [{ key: '1', label: '第一个对象' }, { key: '2', label: '第二个对象' }]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    first.dispose();
    const second = new IarSandboxSession({ mode: 'brain', sessionId: 'clarification-session', snapshotStore });
    try {
      await second.whenReady();
      assert.deepEqual((await second.state()).context.pending.options, [{ key: '1', label: '第一个对象' }, { key: '2', label: '第二个对象' }]);
      assert.equal((await second.turn('1')).status, 'clarification');
      assert.equal((await second.state()).context.pending.status, 'none');
      assert.ok(prompts.some((prompt) => prompt.includes('"options"') && prompt.includes('第一个对象') && prompt.includes('当前用户问题')));
    } finally {
      second.dispose();
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.IAR_LLM_API_KEY; else process.env.IAR_LLM_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.IAR_LLM_BASE_URL; else process.env.IAR_LLM_BASE_URL = originalUrl;
  }
});

type GeneratedResponseWithClarification = {
  clarification?: { options?: Array<{ key: string; label: string }> };
};
