/**
 * 验证 Plugin-first/actionType 范围路由。
 *
 * Plugin 是模型意图识别的一级候选，Function 只在已选 Plugin 内作为二级边界。
 * 测试不允许路由器先构造跨 Plugin 的全局 Function 候选。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCHEMA_VERSIONS,
  validateContract,
  type EventEnvelope,
  type BusinessPluginManifest,
  type ActionType
} from '@iar/contracts';
import { buildIntentDecisionInput, type DecisionRequest } from '@iar/runtime';
import { defineFunction } from '@iar/plugin';
import { PluginHost } from '@iar/plugins';
import { BehaviorContextProjector, createInitialContext, PluginFirstRouter, type AsyncDecisionAdapter, type AsyncFunctionCallAdapter } from '@iar/runtime';
import { facts } from './rule-engine-fixtures.js';
import { pluginPackage } from '../contract/fixtures/plugin-package.js';

const expression = { condition: { field: 'semantic.intent', operator: 'equals', value: 'knowledge.query' } } as const;

function manifest(pluginId: string, functionId: string, actionTypes: ActionType[]) {
  return pluginPackage({
    apiVersion: 'iar.dev/v1',
    schemaVersion: SCHEMA_VERSIONS.pluginManifest,
    pluginId,
    pluginKind: 'business',
    scope: 'plugin',
    version: '1.0.0',
    description: `${pluginId} 查询插件`,
    capabilities: ['knowledge.read'],
    lifecycle: { entrypoint: `${pluginId}.entry` },
    policy: { riskLevel: 'low', requiresConfirmation: false, allowedCapabilities: ['knowledge.read'] },
    dependencies: []
  }, functionId, { actionTypes });
}

function createHost(): PluginHost {
  const host = new PluginHost();
  for (const item of [
    manifest('knowledge-a', 'knowledge.query', ['query']),
    manifest('knowledge-b', 'knowledge.query', ['query']),
    manifest('report-c', 'report.center', ['query'])
  ]) {
    assert.equal(host.install(item).ok, true);
    assert.equal(host.enable(item.pluginId).ok, true);
  }
  return host;
}

test('PluginHost exposes one bounded Plugin descriptor and scoped Function tools', () => {
  const host = createHost();
  const descriptors = host.pluginDescriptors();
  assert.deepEqual(descriptors.map((descriptor) => descriptor.pluginId), ['knowledge-a', 'knowledge-b', 'report-c']);
  assert.equal(descriptors.every((descriptor) => !Object.hasOwn(descriptor, 'functionId')), true);
  const tools = host.functionTools('knowledge-b');
  assert.equal(tools.length > 0, true);
  assert.equal(tools.every((tool) => tool.pluginId === 'knowledge-b'), true);
  assert.equal(tools.every((tool) => tool.functionId === 'knowledge.query'), true);
  assert.equal(host.functionTools('report-c').every((tool) => tool.pluginId === 'report-c'), true);
});

function transferRule() {
  return {
    pluginId: 'human-transfer',
    functionId: 'human.transfer',
    rule: { schemaVersion: SCHEMA_VERSIONS.rule, ruleId: 'rule-human-transfer', version: '1.0.0', target: 'plugin' as const, priority: 100, specificity: 1, unknownFieldPolicy: 'match_none' as const, expression },
    requiredCapabilities: ['knowledge.read']
  };
}

function decisionAdapter(calls: DecisionRequest[], choice?: string, status: 'choice' | 'needs_clarification' = 'choice'): AsyncDecisionAdapter {
  return {
    decide: async ({ request }) => {
      calls.push(request);
      const selected = choice ?? request.candidates[0]?.candidateId;
      return { ok: true, value: {
        schemaVersion: SCHEMA_VERSIONS.decision,
        decisionType: request.decisionType,
        decisionVersion: request.decisionVersion,
        status: selected && status === 'choice' ? 'choice' : status,
        ...(selected && status === 'choice' ? { choice: selected, score: 0.99 } : {}),
        reasonCode: 'test.choice',
        candidateIds: request.candidates.map((candidate) => candidate.candidateId)
      }, audit: [], events: [] };
    }
  };
}

function functionCallAdapter(calls: Array<{ pluginId: string; functionId: string; tools: string[] }>): AsyncFunctionCallAdapter {
  return {
    call: async ({ tools }) => {
      calls.push({ pluginId: tools[0]?.pluginId ?? '', functionId: tools[0]?.functionId ?? '', tools: tools.map((tool) => tool.name) });
      return { ok: true, value: { schemaVersion: 'iar.function-call/v1', pluginId: 'knowledge-b', functionId: 'knowledge.query', operation: tools[0]?.operation ?? 'read', arguments: {}, confidence: 0.99 }, audit: [], events: [] };
    }
  };
}

function request(overrides: Partial<Parameters<PluginFirstRouter['routeAsync']>[0]> = {}) {
  const functionCalls: DecisionRequest[] = [];
  const pluginCalls: DecisionRequest[] = [];
  const routerRequest = {
    traceId: 'trace-plugin-first',
    runId: 'run-plugin-first',
    facts: { ...facts, semantic: { intent: 'knowledge.query', action: 'query' } },
    currentMessage: '帮我查一下知识库',
    tenantId: 'tenant-a',
    actorId: 'actor-a',
    environment: 'test',
    functionRules: [],
    pluginRules: [
      { pluginId: 'knowledge-a', functionId: 'knowledge.query', rule: { schemaVersion: SCHEMA_VERSIONS.rule, ruleId: 'rule-knowledge-a', version: '1.0.0', target: 'plugin' as const, priority: 100, specificity: 1, unknownFieldPolicy: 'match_none' as const, expression }, requiredCapabilities: ['knowledge.read'] },
      { pluginId: 'knowledge-b', functionId: 'knowledge.query', rule: { schemaVersion: SCHEMA_VERSIONS.rule, ruleId: 'rule-knowledge-b', version: '1.0.0', target: 'plugin' as const, priority: 100, specificity: 1, unknownFieldPolicy: 'match_none' as const, expression }, requiredCapabilities: ['knowledge.read'] }
    ],
    pluginHost: createHost(),
    functionDecisionAdapter: decisionAdapter(functionCalls),
    pluginDecisionAdapter: decisionAdapter(pluginCalls, 'knowledge-b'),
    authorizePlugin: () => true,
    ...overrides
  };
  return { routerRequest, functionCalls, pluginCalls };
}

test('FunctionDefinition rejects unknown actionTypes', () => {
  const value = manifest('invalid-action', 'knowledge.query', ['query']);
  const invalid = { ...value.functions[0]!.definition, actionTypes: ['query', 'rank'] };
  const result = validateContract('function', invalid);
  assert.equal(result.ok, false);
});

test('Plugin-first routing sends bounded Plugin descriptions and only selected Plugin Function', async () => {
  const { routerRequest, functionCalls, pluginCalls } = request();
  const result = await new PluginFirstRouter().routeAsync(routerRequest);

  assert.equal(result.status, 'matched');
  assert.equal(result.pluginId, 'knowledge-b');
  assert.equal(result.functionId, 'knowledge.query');
  assert.deepEqual(pluginCalls[0]?.candidates.map((candidate) => candidate.candidateId), ['knowledge-a', 'knowledge-b']);
  assert.equal(pluginCalls[0]?.candidates.some((candidate) => candidate.description === 'knowledge-a 查询插件'), true);
  assert.deepEqual(pluginCalls[0]?.candidates.find((candidate) => candidate.candidateId === 'knowledge-a')?.actionTypes, ['query']);
  assert.deepEqual(functionCalls[0]?.candidates.map((candidate) => candidate.candidateId), ['knowledge.query']);
  assert.deepEqual(result.routingScope, {
    activePluginId: 'knowledge-b',
    candidatePluginIds: ['knowledge-a', 'knowledge-b'],
    actionTypes: ['query'],
    continuation: 'replace'
  });
});

test('Plugin proposal path skips legacy selection models and calls Function Calling inside the selected Plugin', async () => {
  const { routerRequest, functionCalls, pluginCalls } = request();
  const functionCallCalls: Array<{ pluginId: string; functionId: string; tools: string[] }> = [];
  routerRequest.facts = { ...routerRequest.facts, semantic: { intent: 'knowledge.query', action: 'query', pluginId: 'knowledge-b' } };
  routerRequest.functionCallAdapter = functionCallAdapter(functionCallCalls);
  const result = await new PluginFirstRouter().routeAsync(routerRequest);

  assert.equal(result.status, 'matched');
  assert.equal(result.pluginId, 'knowledge-b');
  assert.equal(result.functionId, 'knowledge.query');
  assert.equal(pluginCalls.length, 0);
  assert.equal(functionCalls.length, 0);
  assert.deepEqual(functionCallCalls[0]?.tools, ['knowledge.query.execute']);
});

test('Plugin-first routing excludes Plugins that do not support the semantic action type', async () => {
  const { routerRequest, pluginCalls } = request();
  const transfer = manifest('human-transfer', 'human.transfer', ['transfer']);
  assert.equal(routerRequest.pluginHost.install(transfer).ok, true);
  assert.equal(routerRequest.pluginHost.enable(transfer.pluginId).ok, true);
  routerRequest.pluginRules = [...routerRequest.pluginRules, transferRule()];
  const result = await new PluginFirstRouter().routeAsync(routerRequest);

  assert.equal(result.status, 'matched');
  assert.deepEqual(pluginCalls[0]?.candidates.map((candidate) => candidate.candidateId), ['knowledge-a', 'knowledge-b']);
});

test('Plugin-first routing stops before Function when Plugin decision needs clarification', async () => {
  const { routerRequest, functionCalls, pluginCalls } = request();
  routerRequest.pluginDecisionAdapter = decisionAdapter(pluginCalls, undefined, 'needs_clarification');
  const result = await new PluginFirstRouter().routeAsync(routerRequest);

  assert.equal(result.status, 'needs_clarification');
  assert.equal(functionCalls.length, 0);
  assert.equal(pluginCalls.length, 1);
});

test('Plugin-first routing selects the matching Function inside a multi-Function Plugin', async () => {
  const { routerRequest, functionCalls, pluginCalls } = request();
  const multi = manifest('knowledge-multi', 'knowledge.query', ['query']);
  const first = multi.functions[0]!;
  const second = defineFunction({
    definition: { ...first.definition, functionId: 'report.query', name: '报表查询', description: '报表查询', actionTypes: ['query'] },
    operations: [{ name: 'search', kind: 'read', description: '查询报表' }],
    handler: first.handler
  });
  const packageWithTwoFunctions = { ...multi, functions: [first, second] };
  assert.equal(routerRequest.pluginHost.install(packageWithTwoFunctions).ok, true);
  assert.equal(routerRequest.pluginHost.enable('knowledge-multi').ok, true);
  routerRequest.pluginRules = [...routerRequest.pluginRules, {
    pluginId: 'knowledge-multi',
    functionId: 'report.query',
    rule: { schemaVersion: SCHEMA_VERSIONS.rule, ruleId: 'rule-knowledge-multi-report', version: '1.0.0', target: 'plugin' as const, priority: 100, specificity: 1, unknownFieldPolicy: 'match_none' as const, expression },
    requiredCapabilities: ['knowledge.read']
  }];
  routerRequest.pluginDecisionAdapter = decisionAdapter(pluginCalls, 'knowledge-multi');
  routerRequest.functionDecisionAdapter = decisionAdapter(functionCalls, 'report.query');
  const result = await new PluginFirstRouter().routeAsync(routerRequest);

  assert.equal(result.status, 'matched');
  assert.equal(result.pluginId, 'knowledge-multi');
  assert.equal(result.functionId, 'report.query');
  assert.deepEqual(functionCalls[0]?.candidates.map((candidate) => candidate.candidateId), ['knowledge.query', 'report.query']);
});

test('Intent Model prompt preserves Plugin descriptions and fixed actionTypes', () => {
  const input = buildIntentDecisionInput({
    decisionType: 'plugin.select',
    decisionVersion: 'runtime.v1',
    threshold: 0.7,
    candidates: [{ candidateId: 'knowledge-a', priority: 100, specificity: 1, description: '查询平台知识库', functionId: 'knowledge.query', actionTypes: ['query'] }]
  }) as Record<string, unknown>;
  const request = input.request as { candidates: Array<Record<string, unknown>> };
  assert.equal(request.candidates[0]?.description, '查询平台知识库');
  assert.deepEqual(request.candidates[0]?.actionTypes, ['query']);
});

test('routingScope is projected from decision events and survives context hashing', () => {
  const projector = new BehaviorContextProjector(createInitialContext('run-scope'));
  const event: EventEnvelope = {
    schemaVersion: SCHEMA_VERSIONS.event,
    eventId: 'event-scope',
    eventName: 'decision.created',
    occurredAt: new Date().toISOString(),
    runId: 'run-scope',
    correlationId: 'trace-scope',
    payload: {
      functionId: 'knowledge.query',
      pluginId: 'knowledge-a',
      routingScope: { activePluginId: 'knowledge-a', candidatePluginIds: ['knowledge-a'], actionTypes: ['query'], continuation: 'replace' }
    }
  };
  const next = projector.apply(event);
  assert.deepEqual(next.routingScope, {
    activePluginId: 'knowledge-a',
    candidatePluginIds: ['knowledge-a'],
    actionTypes: ['query'],
    continuation: 'replace'
  });
  assert.equal(next.integrity.lastEventId, 'event-scope');
});
