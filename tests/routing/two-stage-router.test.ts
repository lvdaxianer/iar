/*
 * 验证 Task 2.3 的两阶段路由和运行时重验证边界。
 * Function 必须先于 Plugin，Plugin 规则不能独立启动路由。
 * Function provider 只看到 RuleEngine 生成的有限 Function 候选。
 * Plugin provider 只看到已选 Function 下的 enabled business plugin。
 * PluginHost resolveCandidate 在 provider 返回后再次校验状态和 ownership。
 * authorization callback 每次接收 tenant、actor、environment 和 record。
 * 候选快照阶段授权成功不代表最终选择阶段仍然授权。
 * capability 来自 Manifest，provider 不能向候选增加 capability。
 * 错误 Function 归属必须在 Plugin 阶段被排除。
 * disabled 插件不能因为 provider choice 而进入最终路由。
 * 未授权插件不能因为 provider choice 而进入最终路由。
 * 缺失 required capability 的插件不能进入候选。
 * Function 决策非 choice 时不能查询 PluginHost 或 Plugin provider。
 * Plugin 决策非 choice 时不能返回 matched 路由。
 * 所有拒绝路径都返回稳定 reasonCode，不抛出内部异常。
 * 路由结果携带 Function 和 Plugin DecisionResult 供审计。
 * 本模块不执行 Action、不调用真实插件、不写数据库。
 * 本模块只连接 RuleEngine、DecisionProvider 和 PluginHost 契约。
 * 测试使用内存 PluginHost 和 fixture Manifest，不依赖外部服务。
 * provider response factory 模拟未来真实模型的非可信结构化输出。
 * 每个 provider 输出仍经过 Task 2.2 的统一校验。
 * 两阶段顺序是安全边界，不是性能优化。
 * tenant、actor、environment 作为每次授权输入的不可省略上下文。
 * Function ownership 由规则候选和宿主 resolveCandidate 双重约束。
 * Plugin ownership 由 PluginRule functionId 和 PluginHost 双重约束。
 * enabled 状态由 PluginHost 当前注册表提供，而不是 provider 声明。
 * capability 集合由 Manifest 当前快照提供，而不是模型输出提供。
 * 规则 requiredCapabilities 是允许候选的最小能力集合。
 * 最终重验证重新读取 PluginHost record，避免 stale snapshot 执行。
 * 授权 callback 的两次调用证明 snapshot 与 final gate 都存在。
 * callback 失败只产生 rejected，不自动降级为另一个插件。
 * disabled 插件的规则命中不会改变生命周期状态。
 * authorization false 不会改变注册表状态。
 * ownership mismatch 不会跨 Function 借用插件。
 * candidate list 的顺序由稳定候选排序决定。
 * provider 只能从候选列表中返回 opaque candidateId。
 * provider 不能修改 PluginRecord 或 Manifest。
 * route result 不是 Action authorization，也不是 executor input。
 * Policy Gate 和 confirmation 由 Task 2.4 负责。
 * resume 和 idempotency 由 Task 2.4 负责。
 * 本文件只固定 Task 2.3 的 runtime revalidation 行为。
 * 测试名称映射 OpenSpec Task 2.3 的 acceptance scenarios。
 * focused routing 测试先覆盖该模块，再由 full test 覆盖 Phase 1 回归。
 * build 验证 workspace runtime 包入口和依赖图可用。
 * lint 验证类型边界不会被类型擦除绕过。
 * diff check 验证新增边界文件可提交。
 * 修改路由顺序时必须保持 Function before Plugin 断言。
 * 修改授权策略时必须保持 tenant/actor/environment 断言。
 * 修改宿主状态时必须保持 disabled 和 ownership 断言。
 * 修改 capability 语义时必须保持 Manifest source 断言。
 * 修改 provider 适配时必须保持不可信输出校验断言。
 * 这些测试为后续 Workflow/Policy 模块提供稳定输入。
 * 只有在所有拒绝路径都可回放时才允许进入执行阶段。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { FunctionPluginManifest } from '../../packages/contracts/src/index.js';
import { SCHEMA_VERSIONS } from '../../packages/contracts/src/index.js';
import { DecisionBackendResolver, IntentModelDecisionAdapter, JevDecisionAdapter, loadModelProfiles, MockDecisionProvider, ModelGateway, ModelProfileRegistry, UnifiedDecisionAdapter, type DecisionRequest, type ModelProvider } from '../../packages/decision/src/index.js';
import { PluginHost } from '../../packages/plugin-host/src/index.js';
import { TwoStageRouter, type AsyncDecisionAdapter, type RouteRequest } from '../../packages/runtime/src/index.js';
import { facts, functionRule, pluginRule } from './rule-engine-fixtures.js';

/*
 * 测试断言不仅检查最终状态，也检查阶段顺序和受限输入。
 * Function provider 的 candidateIds 来自规则评估结果。
 * Plugin provider 的 candidateIds 来自当前宿主和 PluginRule 交集。
 * authorization callback 在候选阶段和 selected 阶段分别执行。
 * disabled 状态变化必须在最终 resolveCandidate 阶段被观察。
 * ownership mismatch 不得跨 Function 借用 Plugin。
 * requiredCapabilities 必须来自已重读 Manifest。
 * 两阶段结果都保留 DecisionResult，便于后续审计。
 * 所有断言保持内存确定性，不依赖真实模型或外部服务。
 * 本文件的注释与场景映射用于维护安全边界意图。
 */
/**
 * 读取已通过 Phase 1 contract test 的业务插件 Manifest。
 * @returns 可安装的 FunctionPluginManifest
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function loadManifest(): FunctionPluginManifest {
  const path = join(process.cwd(), 'tests', 'contract', 'fixtures', 'valid-plugin-manifest.json');
  return JSON.parse(readFileSync(path, 'utf8')) as FunctionPluginManifest;
}

/**
 * 创建并启用一个内存 PluginHost，供路由测试控制生命周期。
 * @param overrides - Manifest 覆盖字段
 * @returns 已安装的 PluginHost
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function createHost(overrides: Partial<FunctionPluginManifest> = {}): PluginHost {
  const host = new PluginHost({ functionIds: ['dip.service.stop', 'ticket.create'] });
  const manifest = { ...loadManifest(), ...overrides };
  const installed = host.install(manifest);
  assert.equal(installed.ok, true);
  assert.equal(host.enable(manifest.pluginId).ok, true);
  return host;
}

/**
 * 创建记录请求并返回首个有限候选的确定性 provider。
 * @param calls - 收集 provider 请求的数组
 * @param score - 模拟 provider 输出分数
 * @returns 受 Task 2.2 校验保护的 Mock provider
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function providerFor(calls: DecisionRequest[], score = 0.99): MockDecisionProvider {
  return new MockDecisionProvider((request) => {
    calls.push(request);
    return {
      schemaVersion: SCHEMA_VERSIONS.decision,
      decisionType: request.decisionType,
      decisionVersion: request.decisionVersion,
      status: 'choice',
      choice: request.candidates[0]?.candidateId,
      score,
      reasonCode: 'test.choice',
      candidateIds: request.candidates.map((candidate) => candidate.candidateId)
    };
  });
}

/**
 * 创建两阶段路由的默认输入，调用方只覆盖目标边界。
 * @param overrides - 测试场景的请求覆盖项
 * @returns Function-first 路由请求
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function routeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  const functionCalls: DecisionRequest[] = [];
  const pluginCalls: DecisionRequest[] = [];
  return {
    facts,
    tenantId: 'tenant-a',
    actorId: 'actor-a',
    environment: 'prod',
    functionRules: [functionRule('dip.service.stop', { condition: { field: 'semantic.intent', operator: 'equals', value: 'service.stop' } })],
    pluginRules: [pluginRule('dip-api-stop-v1', { condition: { field: 'semantic.intent', operator: 'equals', value: 'service.stop' } }, { requiredCapabilities: ['dip.service.write'] })],
    pluginHost: createHost(),
    functionProvider: providerFor(functionCalls),
    pluginProvider: providerFor(pluginCalls),
    authorizePlugin: () => true,
    ...overrides
  };
}

/** 创建真实 UnifiedDecisionAdapter 的 Intent-only Function/Plugin pair，供异步路由集成验证。 @returns 两阶段异步模型适配器 @author lvdaxianer@yeah.net @date 2026-10-17 */
function intentOnlyAdapters(): { functionDecisionAdapter: AsyncDecisionAdapter; pluginDecisionAdapter: AsyncDecisionAdapter } {
  const profiles = loadModelProfiles(readFileSync(join(process.cwd(), 'config', 'models.yaml'), 'utf8')).filter((profile) => profile.role !== 'function.select' && profile.role !== 'plugin.select' || profile.profileId === 'function-intent-model-primary' || profile.profileId === 'plugin-intent-model-primary').map((profile) => profile.role === 'function.select' || profile.role === 'plugin.select' ? { ...profile, decisionBackend: 'intent-model' as const } : profile);
  const modelRegistry = new ModelProfileRegistry(profiles);
  const provider: ModelProvider = { complete: async (request) => {
    const prompt = request.input as unknown as { request: DecisionRequest };
    const decision = prompt.request;
    return { schemaVersion: SCHEMA_VERSIONS.decision, decisionType: decision.decisionType, decisionVersion: decision.decisionVersion, status: 'choice', choice: decision.candidates[0]?.candidateId, score: 0.99, reasonCode: 'intent_match', candidateIds: decision.candidates.map((candidate) => candidate.candidateId) };
  } };
  const gateway = new ModelGateway({ registry: modelRegistry, providers: { 'intent-model': provider } });
  const functionAdapter = new UnifiedDecisionAdapter(new DecisionBackendResolver(modelRegistry), new JevDecisionAdapter(gateway, 'function.select'), new IntentModelDecisionAdapter(gateway, 'function.select'));
  const pluginAdapter = new UnifiedDecisionAdapter(new DecisionBackendResolver(modelRegistry), new JevDecisionAdapter(gateway, 'plugin.select'), new IntentModelDecisionAdapter(gateway, 'plugin.select'));
  return { functionDecisionAdapter: functionAdapter, pluginDecisionAdapter: pluginAdapter };
}

/* Function choice 必须先成功，才允许观察 Plugin provider 请求。 */
test('routes Function before Plugin and records both constrained decisions', () => {
  const functionCalls: DecisionRequest[] = [];
  const pluginCalls: DecisionRequest[] = [];
  const request = routeRequest({ functionProvider: providerFor(functionCalls), pluginProvider: providerFor(pluginCalls) });
  const result = new TwoStageRouter().route(request);

  assert.equal(result.status, 'matched');
  assert.equal(result.functionId, 'dip.service.stop');
  assert.equal(result.pluginId, 'dip-api-stop-v1');
  assert.equal(functionCalls[0]?.decisionType, 'function.select');
  assert.equal(pluginCalls[0]?.decisionType, 'plugin.select');
  assert.deepEqual(pluginCalls[0]?.candidates.map((candidate) => candidate.candidateId), ['dip-api-stop-v1']);
});

/* Intent Model 只需返回相同 DecisionResult，路由器不按 backend 分支且仍执行最终门禁。 */
test('consumes an Intent Model-shaped DecisionResult without changing route semantics', () => {
  const intentCompatibleProvider = new MockDecisionProvider((request) => ({
    schemaVersion: SCHEMA_VERSIONS.decision,
    decisionType: request.decisionType,
    decisionVersion: request.decisionVersion,
    status: 'choice' as const,
    choice: request.candidates[0]?.candidateId,
    score: 0.99,
    reasonCode: 'intent_match',
    candidateIds: request.candidates.map((candidate) => candidate.candidateId)
  }));
  const result = new TwoStageRouter().route(routeRequest({ functionProvider: intentCompatibleProvider, pluginProvider: intentCompatibleProvider }));

  assert.equal(result.status, 'matched');
  assert.deepEqual(Object.keys(result.functionDecision ?? {}).sort(), ['candidateIds', 'choice', 'decisionType', 'decisionVersion', 'reasonCode', 'schemaVersion', 'score', 'status']);
  assert.deepEqual(Object.keys(result.pluginDecision ?? {}).sort(), ['candidateIds', 'choice', 'decisionType', 'decisionVersion', 'reasonCode', 'schemaVersion', 'score', 'status']);
});

/* 异步路由入口必须真实经过 UnifiedDecisionAdapter，而不是仅用同步 Mock provider 模拟。 */
test('routeAsync uses Intent Model adapters and preserves final route gates', async () => {
  const { functionProvider: _functionProvider, pluginProvider: _pluginProvider, ...baseRequest } = routeRequest();
  const result = await new TwoStageRouter().routeAsync({ ...baseRequest, traceId: 'trace-async-route', runId: 'run-async-route', ...intentOnlyAdapters() });

  assert.equal(result.status, 'matched');
  assert.equal(result.functionDecision?.reasonCode, 'intent_match');
  assert.equal(result.pluginDecision?.reasonCode, 'intent_match');
  assert.equal(result.pluginId, 'dip-api-stop-v1');
});

/* Function 同等级冲突必须在 Plugin 阶段前停止，避免越过澄清门禁。 */
test('Function clarification stops before Plugin evaluation', () => {
  let pluginInvoked = false;
  const request = routeRequest({
    functionRules: [
      functionRule('function-a', { condition: { field: 'semantic.intent', operator: 'equals', value: 'service.stop' } }, { priority: 100, specificity: 2 }),
      functionRule('function-b', { condition: { field: 'semantic.intent', operator: 'equals', value: 'service.stop' } }, { priority: 100, specificity: 2 })
    ],
    pluginProvider: new MockDecisionProvider(() => {
      pluginInvoked = true;
      return {};
    })
  });
  const result = new TwoStageRouter().route(request);

  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.reasonCode, 'function_needs_clarification');
  assert.equal(pluginInvoked, false);
});

/* 宿主在候选快照后被禁用时，最终 resolveCandidate 必须拒绝 stale choice。 */
test('disabled plugin choice is rejected by finite candidates and host revalidation', () => {
  const host = createHost();
  const request = routeRequest({
    pluginHost: host,
    authorizePlugin: ({ phase }) => {
      if (phase === 'candidate') assert.equal(host.disable('dip-api-stop-v1').ok, true);
      return true;
    },
    pluginProvider: new MockDecisionProvider((decision) => ({
      schemaVersion: SCHEMA_VERSIONS.decision,
      decisionType: decision.decisionType,
      decisionVersion: decision.decisionVersion,
      status: 'choice',
      choice: 'dip-api-stop-v1',
      score: 0.99,
      reasonCode: 'test.disabled-choice',
      candidateIds: ['dip-api-stop-v1']
    }))
  });
  const result = new TwoStageRouter().route(request);

  assert.equal(result.status, 'rejected');
  assert.equal(result.reasonCode, 'plugin_unavailable');
});

/* 候选授权与最终选择授权都必须带完整 tenant/actor/environment 上下文。 */
test('authorization is revalidated with tenant actor and environment after Plugin choice', () => {
  const calls: string[] = [];
  const request = routeRequest({
    authorizePlugin: ({ phase, tenantId, actorId, environment }) => {
      calls.push(`${phase}:${tenantId}:${actorId}:${environment}`);
      return phase === 'candidate';
    }
  });
  const result = new TwoStageRouter().route(request);

  assert.equal(result.status, 'rejected');
  assert.equal(result.reasonCode, 'unauthorized_plugin');
  assert.deepEqual(calls, ['candidate:tenant-a:actor-a:prod', 'selected:tenant-a:actor-a:prod']);
});

/* ownership 和 capability 约束共同决定 Plugin 是否能成为有限候选。 */
test('ownership mismatch and missing capability never become Plugin choices', () => {
  const request = routeRequest({
    pluginRules: [
      pluginRule('dip-api-stop-v1', { condition: { field: 'semantic.intent', operator: 'equals', value: 'service.stop' } }, {
        functionId: 'ticket.create',
        requiredCapabilities: ['dip.service.admin']
      })
    ]
  });
  const result = new TwoStageRouter().route(request);

  assert.equal(result.status, 'noul');
  assert.equal(result.reasonCode, 'plugin_noul');
});

/* 最终宿主快照的 capability 缺失时，provider 不能借输出补回权限。 */
test('final Manifest capability revalidation rejects a stale capability snapshot', () => {
  // 这个伪宿主模拟决策后 capability 快照发生收缩的并发窗口。
  // candidates 阶段仍然提供原始 Manifest capability，确保规则候选合法。
  // resolveCandidate 阶段返回 capability 已撤销的最新记录。
  // provider 没有 capability 字段，因此不能伪造或恢复权限。
  // 最终路由必须读取最新记录而不是复用候选阶段的旧数组。
  // 失败结果仍然携带两阶段证据，便于审计和重放。
  // 该场景不执行插件，也不改变真实 PluginHost 注册表。
  // stale snapshot 只验证 runtime 的 final gate，不替代宿主生命周期测试。
  // requiredCapabilities 由规则声明，Manifest 是唯一能力来源。
  // 断言稳定 reasonCode，避免未来把 capability 失败降级为 noul。
  const host = createHost();
  const record = host.get('dip-api-stop-v1');
  assert.ok(record);
  const staleHost = {
    candidates: () => [record],
    resolveCandidate: () => ({
      ok: true as const,
      value: { ...record, manifest: { ...record.manifest, capabilities: [] } }
    })
  } as unknown as PluginHost;
  const result = new TwoStageRouter().route(routeRequest({ pluginHost: staleHost }));

  assert.equal(result.status, 'rejected');
  assert.equal(result.reasonCode, 'missing_capability');
});
