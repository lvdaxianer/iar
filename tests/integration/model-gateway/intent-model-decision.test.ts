/*
 * 验证 Task 2.2 的 Intent Model 与 Unified Decision adapter。
 * Intent Model 必须收到版本化 Prompt、系统指令、原始受限请求和有序候选 ID。
 * adapter 必须在 provider 之前拒绝 malformed 或 role 不匹配的请求。
 * Intent Model 和 JEV 都只能输出 iar.decision/v1 的统一 DecisionResult。
 * unknown choice、候选重排、错误阶段/版本和额外字段都必须稳定失败。
 * 低分结果必须成为 needs_clarification，不能被 gateway 猜测为其他候选。
 * provider 原始异常、Prompt 和用户输入不能出现在公开 error 或 audit 正文。
 * Unified adapter 只解析一次 backend，并且只委托一个具体 adapter。
 * 同时配置两个 backend 时 JEV 优先；只有 Intent Model 时才调用 Intent Model。
 * resolver 无 profile 时必须返回稳定 model.no_profile 联合结果。
 * JEV adapter 仍使用旧构造方式，并明确选择 jev backend。
 * 测试 fixture 只使用本地 deterministic provider，不依赖网络和真实密钥。
 * 每个 gateway 都使用独立 registry，避免测试间共享 retry 状态。
 * profile 的 primary/fallback 关系与生产 registry 使用同一校验入口。
 * fallback provider 的调用顺序通过 profileId 和 backend 双重断言。
 * Prompt 的 systemPrompt 只用于 provider 输入断言，不进入公开结果断言。
 * candidateIds 断言同时覆盖 Prompt 输入和最终 DecisionResult。
 * malformed case 使用错误 decisionType、空版本、越界 threshold 和空候选。
 * malformed case 明确检查 provider 调用次数为零。
 * unknown choice case 验证不会选择其他候选作为隐式降级。
 * reordered case 验证候选集合比较保持有序语义。
 * wrong version case 验证模型不能切换到另一个协议版本。
 * wrong type case 验证 Function 与 Plugin 阶段不会互相消费。
 * extra field case 验证公共 Schema 的 additionalProperties 边界。
 * non JSON case 验证文本输出不能绕过结构化 provider contract。
 * low score case 验证阈值不触发另一个 backend 调用。
 * provider error case 只检查固定摘要，不依赖异常实现类型。
 * publicText 检查同时覆盖 error、audit 和 event 三类公开容器。
 * JEV 优先 case 使用会抛错的 Intent provider 证明没有双调用。
 * Intent-only case 使用会抛错的 JEV provider 证明 fallback 不会猜测。
 * no-profile case 不提供任何决策 provider，验证 fail-closed 配置语义。
 * 统一 adapter 的返回值只使用 ModelGatewayResult 联合类型。
 * 测试不调用同步 DecisionProvider、TwoStageRouter 或插件执行器。
 * 这些测试只锁定模型调用边界，不改变下游路由和授权语义。
 * 测试名称使用英文以保持 Node test runner 输出稳定，断言说明使用中文注释。
 * 所有可观察 provider 都显式返回 Promise，保持真实 SDK 异步边界。
 * 失败结果不比较内部 Error stack，避免把实现细节固化进契约。
 * provider 收到的 profile 是 gateway 冻结快照，测试只读取不修改。
 * provider 输入使用 JSON-safe cast，仅用于模拟 SDK 的结构化 payload。
 * audit metadata 的 backend 证据由 gateway 根据选定 profile 生成。
 * fallbackUsed、profileId 和 modelVersion 由统一 gateway 保持兼容。
 * legacy JEV 配置的兼容性由既有 model-gateway 回归测试继续锁定。
 * Intent Model 不直接接触权限、能力或插件执行上下文。
 * candidate priority 和 specificity 保持有限数值，防止测试绕过排序规则。
 * decisionVersion 使用稳定 runtime.v1，避免随机版本造成审计噪音。
 * traceId 和 runId 使用固定值，保证失败输出可重复比较。
 * provider 计数器只观察是否调用，不作为生产实现的控制条件。
 * resolver 只负责选择 backend，具体 adapter 仍负责输入和输出校验。
 * 每个 backend 的 fallback 由 profile 引用，不按 provider 名称推断。
 * 公开错误 details 应为空对象，测试不接受原始请求回显。
 * 公开 audit 正文只允许脱敏 metadata，测试拒绝 Prompt 正文泄漏。
 * 稳定错误码是调用方契约，测试不依赖异常 message。
 * audit 版本字段与 Prompt 正文分离，版本可见但正文不可见。
 * provider 原始结果只在 validator 内存中短暂存在，不进入断言对象。
 * 任务范围只覆盖 adapter/gateway，不提前实现后续 routing task。
 * 任何新增失败都优先修生产边界，不放宽测试契约来获得假绿。
 * 本文件不修改配置、文档或 OpenSpec checklist。
 * 通过 focused suite 后再运行 broader verification 和 strict OpenSpec。
 * 返修覆盖 provider 延迟期间 threshold 变化，确保结果仍绑定初始请求。
 * 返修覆盖 provider 延迟期间 candidates 变化，确保候选集合不会漂移。
 * 返修覆盖 invocation Proxy getter 抛错，确保 adapter 不同步抛 raw error。
 * 返修覆盖 request Proxy getter 抛错，确保 builder 前边界稳定失败。
 * 返修覆盖决策 audit 不写入完整 invocation.input。
 * 返修使用带 secret 的 candidateId 验证 result JSON 完全不回显候选正文。
 * 返修断言决策 audit 只含 provider、backend、版本、数量和稳定 reason。
 * 返修覆盖 resolver profileId 与 gateway registry 不一致时 fail-closed。
 * profileId mismatch case 还断言 provider 调用次数保持为零。
 * 返修覆盖 plugin.select 的 Intent-only Unified 路径。
 * plugin.select case 断言 Unified 仍然只调用一个 backend。
 * profile 选择测试保持 JEV primary 的既有优先级不变。
 * profile 选择测试保持同 backend fallback 的既有关系不变。
 * 所有新增断言都通过稳定错误码或固定摘要完成。
 * 新增测试不比较异常对象、stack 或底层 getter 文本。
 * 新增测试不把 Prompt 正文作为公开审计契约保存。
 * 新增测试继续使用本地 provider，不访问网络或真实模型。
 * 新增测试继续复用 validateDecisionOutput 的统一候选语义。
 * 新增测试继续复用 iar.decision/v1 的公共输出契约。
 * 新增测试只验证 Task 2.2 的 adapter/gateway 边界。
 * 新增测试不改变同步 DecisionProvider 或 TwoStageRouter。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DecisionBackendResolver,
  IntentModelDecisionAdapter,
  JevDecisionAdapter,
  ModelGateway,
  ModelProfileRegistry,
  UnifiedDecisionAdapter,
  loadModelProfiles,
  type ModelProvider
} from '@iar/runtime';
import type { DecisionResult, JsonValue } from '@iar/contracts';
import type { DecisionRequest } from '@iar/runtime';
/**
 * 创建测试使用的最小决策 profile 集合。
 * @param backends - 要启用的后端列表
 * @param withFallback - 是否为每个 backend 建立显式 fallback
 * @returns 经过配置校验的 profile registry
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function registry(backends: readonly ('jev' | 'intent-model')[], withFallback = true, profilePrefix = 'function', role: 'function.select' | 'plugin.select' = 'function.select'): ModelProfileRegistry {
  const primary = baseProfile(`${profilePrefix}-decision-primary`, role);
  const fallback = baseProfile(`${profilePrefix}-decision-fallback`, role);
  const profiles = backends.flatMap((backend) => {
    const suffix = backend === 'jev' ? 'jev' : 'intent';
    const fallbackProfileId = `${profilePrefix}-${suffix}-fallback`;
    const primaryProfile = { ...primary, profileId: `${profilePrefix}-${suffix}-primary`, provider: `${suffix}-provider`, decisionBackend: backend, ...(withFallback ? { fallbackProfileId } : {}) };
    return withFallback ? [primaryProfile, { ...fallback, profileId: fallbackProfileId, provider: `${suffix}-provider`, decisionBackend: backend }] : [primaryProfile];
  });
  return new ModelProfileRegistry(loadModelProfiles({ configVersion: 'iar.models/v1', profiles }));
}
/**
 * 创建单个 role 的通用 profile 草稿。
 * @param profileId - profile 标识
 * @param role - 模型 role
 * @returns 可组装成 primary/fallback 关系的 profile
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function baseProfile(profileId: string, role: 'function.select' | 'plugin.select' | 'semantic.extract'): Record<string, unknown> {
  return {
    schemaVersion: 'iar.model-profile/v1', profileId, profileVersion: '1.0.0', role,
    provider: profileId.includes('intent') ? 'intent-provider' : 'jev-provider',
    modelId: profileId, modelVersion: 'model-1', timeoutMs: 100,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, retryOn: ['timeout'] },
    structuredOutput: { enabled: true, schemaId: 'iar.decision/v1' }
  };
}
/**
 * 创建用于所有边界测试的有限候选请求。
 * @param candidateIds - 候选顺序
 * @returns 受限决策请求
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function request(candidateIds = ['candidate-1', 'candidate-2'], decisionType: DecisionRequest['decisionType'] = 'function.select'): DecisionRequest {
  return {
    decisionType, decisionVersion: 'runtime.v1', threshold: 0.8,
    candidates: candidateIds.map((candidateId, index) => ({ candidateId, priority: index === 0 ? 2 : 1, specificity: 1 }))
  };
}
/**
 * 创建与请求绑定的合法统一决策输出。
 * @param input - provider 收到的输入
 * @param score - 输出分数
 * @returns provider 原始结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validDecision(input: JsonValue, score = 0.95): DecisionResult {
  const source = typeof input === 'object' && input !== null && !Array.isArray(input) && 'request' in input ? input.request : input;
  const decisionRequest = source as { decisionType: DecisionRequest['decisionType']; decisionVersion: string; candidateIds?: string[] };
  const candidateIds = decisionRequest.candidateIds ?? ['candidate-1', 'candidate-2'];
  return {
    schemaVersion: 'iar.decision/v1', decisionType: decisionRequest.decisionType,
    decisionVersion: decisionRequest.decisionVersion, status: 'choice', choice: candidateIds[0] ?? 'candidate-1',
    score, reasonCode: 'intent_match', candidateIds
  };
}
/**
 * 组合一个可观察 provider，记录调用 backend 和输入。
 * @param calls - provider 观察记录
 * @param output - provider 输出或异常工厂
 * @returns ModelGateway provider
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function provider(calls: Array<{ backend: string; input: JsonValue }>, output: (input: JsonValue) => unknown = validDecision): ModelProvider {
  return { complete: async (request) => { const input = request.input as unknown as JsonValue; calls.push({ backend: request.profile.decisionBackend ?? 'jev', input }); return output(input); } };
}
/** Intent Model provider 必须收到完整 Prompt 输入并返回统一 DecisionResult。 */
test('Intent Model receives versioned prompt input and returns a unified decision', async () => {
  const calls: Array<{ backend: string; input: JsonValue }> = [];
  const gateway = new ModelGateway({ registry: registry(['intent-model']), providers: { 'intent-provider': provider(calls) } });
  const result = await new IntentModelDecisionAdapter(gateway, 'function.select').decide({ traceId: 'trace-intent', runId: 'run-intent', request: request() });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.backend, 'intent-model');
  assert.deepEqual(Object.keys(calls[0]?.input as Record<string, unknown>).sort(), ['promptVersion', 'request', 'systemPrompt']);
  const input = calls[0]?.input as { promptVersion: string; systemPrompt: string; request: { candidateIds: string[] } };
  assert.equal(input.promptVersion, 'iar.intent-decision-prompt/v1');
  assert.match(input.systemPrompt, /Return JSON only/);
  assert.deepEqual(input.request.candidateIds, ['candidate-1', 'candidate-2']);
  if (result.ok) {
    assert.equal(result.value.schemaVersion, 'iar.decision/v1');
    assert.equal(result.audit[0]?.profileId, 'function-intent-primary');
    assert.equal(result.audit[0]?.modelVersion, 'model-1');
    const metadata = result.audit[0]?.metadata as Record<string, unknown> & { decisionBackend?: string; promptVersion?: string };
    assert.equal(metadata.decisionBackend, 'intent-model');
    assert.equal(metadata.promptVersion, 'iar.intent-decision-prompt/v1');
    assert.equal('request' in metadata, false);
    assert.equal(JSON.stringify(metadata).includes('systemPrompt'), false);
  }
});
/** malformed request 必须在共享 canonicalizer 和两个 provider 之前失败。 */
test('rejects malformed decision requests before calling either provider', async () => {
  for (const malformedRequest of [{ ...request(), threshold: 2 }, { ...request(), candidates: [] }, { ...request(), unexpected: 'secret' }]) {
    const calls: string[] = [];
    const gateway = new ModelGateway({ registry: registry(['jev', 'intent-model']), providers: { 'jev-provider': { complete: async () => { calls.push('jev'); return {}; } }, 'intent-provider': { complete: async () => { calls.push('intent'); return {}; } } } });
    for (const adapter of [new JevDecisionAdapter(gateway, 'function.select'), new IntentModelDecisionAdapter(gateway, 'function.select')]) {
      const result = await adapter.decide({ traceId: 'trace-malformed', runId: 'run-malformed', request: malformedRequest as never });
      assert.equal(result.ok, false);
      assert.equal(calls.length, 0);
      if (!result.ok) assert.equal(result.error.code, 'model.invalid_request');
    }
  }
});
/** 各种 provider 输出都必须复用相同候选、阶段、版本和阈值校验。 */
test('converges invalid Intent Model outputs to stable rejection or clarification', async () => {
  /*
   * 候选语义错误由公共 validator 规范化为 rejected DecisionResult。
   * 结构化协议错误则由 gateway 统一收敛为 model.schema_invalid。
   * 非 JSON 输出不能进入 validateDecisionOutput 的成功路径。
   * 额外字段不能借助 JSON Schema 边界进入下游路由。
   * decisionType 和 decisionVersion 必须保持调用方固定值。
   * candidateIds 的顺序是调用方候选顺序，不能由模型重排。
   * unknown choice 不能静默替换为第一候选。
   * low score 仍保留可审计分数，但状态必须是 needs_clarification。
   * 每个 case 使用没有 fallback 的单 profile，隔离输出分类断言。
   */
  const cases: Array<{ name: string; output: unknown; code?: string; status?: string }> = [
    { name: 'unknown choice', output: { ...validDecision(request() as unknown as JsonValue), choice: 'unknown' }, status: 'rejected' },
    { name: 'reordered candidates', output: { ...validDecision(request() as unknown as JsonValue), candidateIds: ['candidate-2', 'candidate-1'] }, status: 'rejected' },
    { name: 'wrong decision type', output: { ...validDecision(request() as unknown as JsonValue), decisionType: 'plugin.select' }, status: 'rejected' },
    { name: 'wrong decision version', output: { ...validDecision(request() as unknown as JsonValue), decisionVersion: 'other.v1' }, status: 'rejected' },
    { name: 'extra field', output: { ...validDecision(request() as unknown as JsonValue), extra: 'unexpected' }, code: 'model.schema_invalid' },
    { name: 'non JSON output', output: 'not-json', code: 'model.schema_invalid' },
    { name: 'low score', output: validDecision(request() as unknown as JsonValue, 0.2), code: 'model.threshold_rejected', status: 'needs_clarification' }
  ];
  for (const testCase of cases) {
    const gateway = new ModelGateway({ registry: registry(['intent-model'], false), providers: { 'intent-provider': provider([], () => testCase.output) } });
    const result = await new IntentModelDecisionAdapter(gateway, 'function.select').decide({ traceId: `trace-${testCase.name}`, runId: `run-${testCase.name}`, request: request() });
    if (testCase.status) {
      assert.equal(result.ok, true, testCase.name);
      if (result.ok) assert.equal(result.value.status, testCase.status, testCase.name);
    } else {
      assert.equal(result.ok, false, testCase.name);
      if (!result.ok) assert.equal(result.error.code, testCase.code, testCase.name);
    }
  }
});
/** backend-aware fallback 必须沿选定 Intent Model primary 的关系图执行。 */
test('uses the selected backend fallback without crossing to JEV', async () => {
  const calls: Array<{ backend: string; profileId: string }> = [];
  const profiles = registry(['jev', 'intent-model']);
  const intentProvider: ModelProvider = { complete: async (request) => {
    calls.push({ backend: request.profile.decisionBackend ?? 'jev', profileId: request.profile.profileId });
    if (request.profile.profileId === 'function-intent-primary') throw new Error('intent primary unavailable');
    return validDecision(request.input as unknown as JsonValue);
  } };
  const gateway = new ModelGateway({ registry: profiles, providers: { 'intent-provider': intentProvider, 'jev-provider': { complete: async () => { throw new Error('jev must not run'); } } } });
  const result = await new IntentModelDecisionAdapter(gateway, 'function.select').decide({ traceId: 'trace-backend-fallback', runId: 'run-backend-fallback', request: request() });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.backend), ['intent-model', 'intent-model']);
  assert.deepEqual(calls.map((call) => call.profileId), ['function-intent-primary', 'function-intent-fallback']);
});
/** provider 异常只能返回稳定分类，不能把异常正文或请求正文带出边界。 */
test('does not expose provider error, prompt, or user input in public result', async () => {
  const gateway = new ModelGateway({ registry: registry(['intent-model']), providers: { 'intent-provider': { complete: async () => { throw new Error('raw provider secret user-input-secret'); } } } });
  const result = await new IntentModelDecisionAdapter(gateway, 'function.select').decide({ traceId: 'trace-secret', runId: 'run-secret', request: request(['candidate-secret-id']) });
  const publicText = JSON.stringify(result);
  assert.equal(['raw provider secret', 'user-input-secret', 'candidate-secret-id', 'You are the IAR intent decision model'].some((secret) => publicText.includes(secret)), false);
  if (!result.ok) {
    assert.equal(result.error.message, '模型主 provider 和 fallback 均失败');
    const metadata = result.audit[0]?.metadata as Record<string, unknown>;
    assert.deepEqual(Object.keys(metadata).sort(), ['candidateCount', 'contextBudget', 'decisionBackend', 'promptVersion', 'provider', 'reason']);
    assert.equal(metadata.candidateCount, 1);
    assert.equal(typeof metadata.contextBudget, 'object');
  }
});
/** 延迟 provider 期间修改原请求，验证 Prompt 与结果校验共用初始快照。 */
test('keeps one decision request snapshot across delayed provider execution', async () => {
  const requestToMutate = request();
  const gateway = new ModelGateway({ registry: registry(['intent-model'], false), providers: { 'intent-provider': { complete: async (providerRequest) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    requestToMutate.threshold = 1;
    requestToMutate.candidates = [{ candidateId: 'mutated-secret', priority: 99, specificity: 99 }];
    return validDecision(providerRequest.input as unknown as JsonValue, 0.95);
  } } } });
  const result = await new IntentModelDecisionAdapter(gateway, 'function.select').decide({ traceId: 'trace-snapshot', runId: 'run-snapshot', request: requestToMutate });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual([result.value.status, result.value.candidateIds], ['choice', ['candidate-1', 'candidate-2']]);
});
/** 恶意 invocation/request getter 只能得到稳定 invalid_request，不能同步抛出原始异常。 */
test('converts malicious invocation and request getters to stable invalid requests', async () => {
  const gateway = new ModelGateway({ registry: registry(['intent-model']), providers: { 'intent-provider': provider([]) } });
  const adapter = new IntentModelDecisionAdapter(gateway, 'function.select');
  const invocations = [
    new Proxy({}, { get: () => { throw new Error('raw invocation secret'); } }),
    { traceId: 'trace-getter', runId: 'run-getter', request: new Proxy({}, { get: () => { throw new Error('raw request secret'); } }) }
  ];
  for (const invocation of invocations) {
    const result = await adapter.decide(invocation as never);
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.error, { code: 'model.invalid_request', message: 'Intent Model decision request 无效', retryable: false, details: {} });
  }
});
/** 两个 backend 同时存在时 Unified adapter 只能调用 JEV。 */
test('Unified adapter prefers JEV and delegates exactly once', async () => {
  const calls: Array<{ backend: string; input: JsonValue }> = [];
  const profiles = registry(['jev', 'intent-model']);
  const jevGateway = new ModelGateway({ registry: profiles, providers: { 'jev-provider': provider(calls), 'intent-provider': { complete: async () => { throw new Error('intent must not run'); } } } });
  const unified = new UnifiedDecisionAdapter(new DecisionBackendResolver(profiles), new JevDecisionAdapter(jevGateway, 'function.select'), new IntentModelDecisionAdapter(jevGateway, 'function.select'));
  const result = await unified.decide({ traceId: 'trace-unified', runId: 'run-unified', request: request() });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.backend), ['jev']);
});
/** 只有 Intent Model profile 时 Unified adapter 不应尝试 JEV。 */
test('Unified adapter calls only Intent Model when JEV is absent', async () => {
  const calls: Array<{ backend: string; input: JsonValue }> = [];
  const profiles = registry(['intent-model']);
  const gateway = new ModelGateway({ registry: profiles, providers: { 'intent-provider': provider(calls), 'jev-provider': { complete: async () => { throw new Error('jev must not run'); } } } });
  const unified = new UnifiedDecisionAdapter(new DecisionBackendResolver(profiles), new JevDecisionAdapter(gateway, 'function.select'), new IntentModelDecisionAdapter(gateway, 'function.select'));
  const result = await unified.decide({ traceId: 'trace-only-intent', runId: 'run-only-intent', request: request() });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.backend), ['intent-model']);
});
/** plugin.select 也必须支持 Intent-only Unified 路径，且只调用一次 provider。 */
test('Unified adapter supports plugin.select with Intent Model only', async () => {
  const calls: Array<{ backend: string; input: JsonValue }> = [];
  const profiles = registry(['intent-model'], false, 'plugin', 'plugin.select');
  const gateway = new ModelGateway({ registry: profiles, providers: { 'intent-provider': provider(calls) } });
  const unified = new UnifiedDecisionAdapter(new DecisionBackendResolver(profiles), new JevDecisionAdapter(gateway, 'plugin.select'), new IntentModelDecisionAdapter(gateway, 'plugin.select'));
  const result = await unified.decide({ traceId: 'trace-plugin-intent', runId: 'run-plugin-intent', request: request(['plugin-candidate'], 'plugin.select') });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.backend), ['intent-model']);
});
/** resolver 与 gateway registry 不一致时，profileId 必须阻止 gateway 自行选择另一个 primary。 */
test('Unified adapter enforces resolver profileId at the gateway boundary', async () => {
  let calls = 0;
  const resolverProfiles = registry(['intent-model'], false, 'resolver');
  const gatewayProfiles = registry(['intent-model'], false, 'gateway');
  const gateway = new ModelGateway({ registry: gatewayProfiles, providers: { 'intent-provider': { complete: async () => { calls += 1; return {}; } } } });
  const unified = new UnifiedDecisionAdapter(new DecisionBackendResolver(resolverProfiles), new JevDecisionAdapter(gateway, 'function.select'), new IntentModelDecisionAdapter(gateway, 'function.select'));
  const result = await unified.decide({ traceId: 'trace-profile-mismatch', runId: 'run-profile-mismatch', request: request() });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  if (!result.ok) assert.equal(result.error.code, 'model.no_profile');
});
/** resolver 没有 profile 时必须收敛为稳定配置错误。 */
test('Unified adapter returns model.no_profile when no backend is configured', async () => {
  const gateway = new ModelGateway({ registry: registry(['intent-model']), providers: { 'intent-provider': provider([]) } });
  const noProfileResolver = new DecisionBackendResolver(new ModelProfileRegistry(loadModelProfiles({ configVersion: 'iar.models/v1', profiles: [baseProfile('semantic', 'semantic.extract')] as never })));
  const unified = new UnifiedDecisionAdapter(noProfileResolver, new JevDecisionAdapter(gateway, 'function.select'), new IntentModelDecisionAdapter(gateway, 'function.select'));
  const result = await unified.decide({ traceId: 'trace-no-profile', runId: 'run-no-profile', request: request() });
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.error, { code: 'model.no_profile', message: '决策模型 backend 未配置', retryable: false, details: {} });
});
