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
  type FunctionPluginManifest
} from '@iar/contracts';
import { buildIntentDecisionInput, type DecisionRequest } from '@iar/decision';
import { PluginHost } from '@iar/plugins';
import { BehaviorContextProjector, createInitialContext, PluginFirstRouter, type AsyncDecisionAdapter } from '@iar/runtime';
import { facts } from './rule-engine-fixtures.js';

const expression = { condition: { field: 'semantic.intent', operator: 'equals', value: 'knowledge.query' } } as const;

function manifest(pluginId: string, functionId: string, actionTypes: FunctionPluginManifest['actionTypes']): FunctionPluginManifest {
  return {
    apiVersion: 'iar.dev/v1',
    schemaVersion: SCHEMA_VERSIONS.pluginManifest,
    pluginId,
    pluginKind: 'function',
    scope: 'function',
    functionId,
    version: '1.0.0',
    description: `${pluginId} 查询插件`,
    actionTypes,
    capabilities: ['knowledge.read'],
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object', additionalProperties: false },
    lifecycle: { entrypoint: `${pluginId}.entry` },
    policy: { riskLevel: 'low', requiresConfirmation: false, allowedCapabilities: ['knowledge.read'] },
    dependencies: []
  };
}

function createHost(): PluginHost {
  const host = new PluginHost({ functionIds: ['knowledge.query', 'report.center', 'human.transfer'] });
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

test('FunctionPluginManifest rejects unknown actionTypes', () => {
  const value = manifest('invalid-action', 'knowledge.query', ['query']);
  const invalid = { ...value, actionTypes: ['query', 'rank'] };
  const result = validateContract('pluginManifest', invalid);
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
