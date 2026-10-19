/*
 * Task 2.3 审计契约证据：只验证 ModelGatewayResult 的公开 audit/event 边界。
 * 不调用同步 runtime、路由器或插件执行器，避免提前扩展 Task 3。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DecisionResult, JsonValue } from '@iar/contracts';
import {
  DecisionBackendResolver,
  IntentModelDecisionAdapter,
  JevDecisionAdapter,
  MODEL_NO_PROFILE_MESSAGE,
  ModelGateway,
  ModelProfileRegistry,
  UnifiedDecisionAdapter,
  type ModelProvider
} from '@iar/decision';
import type { DecisionRequest } from '@iar/decision';

type Backend = 'jev' | 'intent-model';
type AuditMetadata = Record<string, JsonValue>;

/**
 * 创建带显式版本和 backend 的最小 profile。
 * @param profileId - profile 稳定标识
 * @param role - 模型调用角色
 * @param backend - 决策 backend
 * @param fallbackProfileId - 可选 fallback profile 标识
 * @returns 可供 ModelProfileRegistry 校验的 profile 草稿
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function profile(profileId: string, role: DecisionRequest['decisionType'] | 'semantic.extract', backend?: Backend, fallbackProfileId?: string) {
  return { schemaVersion: 'iar.model-profile/v1' as const, profileId, profileVersion: profileId.includes('fallback') ? '1.0.1' : '1.0.0', role, ...(backend ? { decisionBackend: backend } : {}), provider: `${profileId}-provider`, modelId: `${profileId}-model`, modelVersion: `${profileId}@model`, timeoutMs: 100, retryPolicy: { maxAttempts: 1, backoffMs: 0, retryOn: ['provider_failed'] }, ...(fallbackProfileId ? { fallbackProfileId } : {}), structuredOutput: { enabled: true, schemaId: 'iar.decision/v1' } };
}

/**
 * 创建唯一最高优先级的有限候选请求。
 * @param candidateId - 最高优先级候选标识
 * @param decisionType - 决策阶段
 * @param includeUserInputSecret - 是否将用户输入哨兵放入候选输入
 * @returns 受限决策请求
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function request(candidateId = 'candidate-1', decisionType: DecisionRequest['decisionType'] = 'function.select', includeUserInputSecret = false): DecisionRequest {
  const primaryCandidate = { candidateId, priority: 2, specificity: 1, ...(includeUserInputSecret ? { evidenceCodes: ['user-input-secret'] } : {}) };
  return { decisionType, decisionVersion: 'runtime.v1', threshold: 0.8, candidates: [primaryCandidate, { candidateId: 'candidate-2', priority: 1, specificity: 1 }] };
}

/**
 * 将 JEV 或 Intent Model 的 provider 输入转换为统一合法结果。
 * @param input - provider 收到的 JEV request 或 Intent envelope
 * @returns 统一 DecisionResult
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function decision(input: JsonValue): DecisionResult {
  const record = input as Record<string, JsonValue>;
  const nested = record.request as Record<string, JsonValue> | undefined;
  const source = nested ?? record;
  const ids = Array.isArray(source.candidateIds) ? source.candidateIds.filter((value): value is string => typeof value === 'string') : Array.isArray(source.candidates) ? source.candidates.flatMap((candidate) => typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate) && typeof candidate.candidateId === 'string' ? [candidate.candidateId] : []) : [];
  const decisionType = typeof source.decisionType === 'string' ? source.decisionType : 'function.select';
  const decisionVersion = typeof source.decisionVersion === 'string' ? source.decisionVersion : 'runtime.v1';
  return { schemaVersion: 'iar.decision/v1', decisionType: decisionType as DecisionResult['decisionType'], decisionVersion, status: 'choice', choice: ids[0] as string, score: 0.95, reasonCode: 'intent_match', candidateIds: ids };
}

/**
 * 创建只观察 provider 输入和调用顺序的 deterministic provider。
 * @param observed - provider 观察记录
 * @param output - 根据输入返回结果或异常的工厂
 * @returns 本地 deterministic provider
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function observingProvider(observed: Array<{ profileId: string; input: JsonValue }>, output: (input: JsonValue) => unknown = decision): ModelProvider {
  return { complete: async (providerRequest) => { observed.push({ profileId: providerRequest.profile.profileId, input: providerRequest.input as JsonValue }); return output(providerRequest.input as JsonValue); } };
}

/**
 * 创建绑定单一 role 的统一 adapter。
 * @param role - 决策阶段
 * @param profiles - profile registry
 * @param providers - provider 白名单
 * @returns 统一决策 adapter
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function unified(role: 'function.select' | 'plugin.select', profiles: ModelProfileRegistry, providers: Readonly<Record<string, ModelProvider>>) {
  const gateway = new ModelGateway({ registry: profiles, providers });
  return new UnifiedDecisionAdapter(new DecisionBackendResolver(profiles), new JevDecisionAdapter(gateway, role), new IntentModelDecisionAdapter(gateway, role));
}

/**
 * 对成功结果逐字段锁定公开 DecisionResult 契约。
 * @param value - adapter 返回的 DecisionResult
 * @param decisionType - 预期决策阶段
 * @param candidateIds - 预期有序候选标识
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertDecisionValue(value: DecisionResult, decisionType: DecisionRequest['decisionType'], candidateIds: readonly string[]): void {
  // 逐字段断言，避免只比较对象存在而遗漏协议值漂移。
  assert.equal(value.schemaVersion, 'iar.decision/v1');
  assert.equal(value.decisionType, decisionType);
  assert.equal(value.decisionVersion, 'runtime.v1');
  assert.equal(value.status, 'choice');
  assert.equal(value.choice, candidateIds[0]);
  assert.equal(value.score, 0.95);
  assert.equal(value.reasonCode, 'intent_match');
  assert.deepEqual(value.candidateIds, candidateIds);
}

/*
 * 选择 backend 的证据必须来自实际 resolver 和 profile。
 * 测试不直接伪造 audit，也不读取 provider 内部实现细节。
 * JEV 和 Intent Model 各自通过真实 adapter 进入同一 gateway。
 * 这样可以同时验证 resolver 选择和公开结果封装。
 * audit 与 event 使用同一份稳定快照，避免两个出口漂移。
 * 结果字段使用值级断言，防止只验证 key 集合的弱证据。
 * Intent Prompt 版本只作为 metadata 证据公开。
 */
/** JEV 和 Intent Model 的公开审计/event 必须记录选定 backend 和值级结果。 */
test('records selected backend and symmetric value contract', async () => {
  for (const backend of ['jev', 'intent-model'] as const) {
    const observed: Array<{ profileId: string; input: JsonValue }> = [];
    const primary = profile(`${backend}-primary`, 'function.select', backend);
    const providers = { [primary.provider]: observingProvider(observed) };
    const profiles = new ModelProfileRegistry([primary]);
    const gateway = new ModelGateway({ registry: profiles, providers });
    const adapter = backend === 'jev'
      ? new JevDecisionAdapter(gateway, 'function.select')
      : new IntentModelDecisionAdapter(gateway, 'function.select');
    const result = await adapter.decide({ traceId: `trace-${backend}`, runId: `run-${backend}`, request: request() });

    // 两个 adapter 必须暴露同一 ModelGatewayResult 顶层结构。
    assert.deepEqual(Object.keys(result).sort(), ['audit', 'events', 'ok', 'value']);
    assert.equal(result.ok, true);
    assert.deepEqual(observed.map((entry) => entry.profileId), [primary.profileId]);
    if (!result.ok) return;

    /*
     * 成功值必须是现有 iar.decision/v1，而不是 backend 私有协议。
     * choice 只能来自有限候选，score 和 reasonCode 也必须保留。
     * audit 顶层版本字段来自实际 profile，而非 provider 输入。
     * event.audit 必须与 audit[0] 完全一致。
     */
    // value 和 audit/event 均锁定为公开、可回放的稳定契约。
    assertDecisionValue(result.value, 'function.select', ['candidate-1', 'candidate-2']);
    assert.deepEqual(Object.keys(result.value).sort(), ['candidateIds', 'choice', 'decisionType', 'decisionVersion', 'reasonCode', 'schemaVersion', 'score', 'status']);
    assert.equal(result.audit.length, 1);
    assert.equal(result.events.length, 1);
    const entry = result.audit[0];
    const event = result.events[0];
    assert.ok(entry);
    assert.ok(event);
    const expectedMetadata: AuditMetadata = { provider: primary.provider, candidateCount: 2, decisionBackend: backend };
    if (backend === 'intent-model') expectedMetadata.promptVersion = 'iar.intent-decision-prompt/v1';
    assert.deepEqual(entry.metadata, expectedMetadata);
    assert.deepEqual(event.audit, entry);
    assert.deepEqual(Object.keys(event).sort(), ['audit', 'eventName']);
  }
});

/*
 * 敏感测试故意让 provider 抛出原始异常。
 * candidateId 和 user-input-secret 同时存在于 Intent 输入。
 * systemPrompt 只应存在于 provider 请求生命周期内。
 * 公开 error 只能携带稳定 code、message、retryable 和空 details。
 * 公开 audit 只能携带白名单 metadata。
 * 公开 events 复用同一脱敏 audit，不得形成第二条泄漏路径。
 * 版本证据可见，但 Prompt 正文不可见。
 */
/** Intent Prompt 只允许固定版本进入 metadata，正文和输入不得进入公开结果。 */
test('keeps Intent metadata on an exact whitelist and redacts secrets', async () => {
  const observed: Array<{ profileId: string; input: JsonValue }> = [];
  const primary = profile('intent-primary', 'function.select', 'intent-model');
  const result = await new IntentModelDecisionAdapter(
    new ModelGateway({
      registry: new ModelProfileRegistry([primary]),
      providers: {
        [primary.provider]: observingProvider(observed, async () => { throw new Error('raw-provider-secret'); })
      }
    }),
    'function.select'
  ).decide({ traceId: 'trace-secret', runId: 'run-secret', request: request('secret-candidate-id', 'function.select', true) });

  assert.equal(result.ok, false);
  assert.equal(observed.length, 1);
  if (!result.ok) assert.deepEqual(result.error, { code: 'model.provider_failed', message: '模型 provider 调用失败', retryable: true, details: {} });
  assert.equal(result.audit.length, 1);
  assert.equal(result.events.length, 1);

  // provider 必须确实收到 secret candidate；secret 只允许停留在输入边界。
  const providerInput = JSON.stringify(observed[0]?.input);
  assert.equal(providerInput.includes('secret-candidate-id'), true);
  assert.equal(providerInput.includes('user-input-secret'), true);
  // metadata 只允许稳定 provider、数量、backend、Prompt 版本和失败原因。
  const metadata = result.audit[0]?.metadata as AuditMetadata;
  assert.deepEqual(Object.keys(metadata).sort(), ['candidateCount', 'decisionBackend', 'promptVersion', 'provider', 'reason']);
  assert.deepEqual(metadata, {
    provider: primary.provider,
    candidateCount: 2,
    decisionBackend: 'intent-model',
    promptVersion: 'iar.intent-decision-prompt/v1',
    reason: '模型 provider 调用失败'
  });
  /*
   * 这里逐个检查 audit 和 event 的 metadata，而不是只检查 JSON 文本。
   * request 是 Intent provider 的完整 envelope，必须永不进入公开审计。
   * systemPrompt 包含模型约束正文，不能作为诊断字段回传。
   * candidateId 可能包含业务敏感标识，只能在输入边界存在。
   * exact whitelist 同时锁定字段新增时的安全回归。
   */
  // audit 和 event 都必须使用同一份脱敏 metadata，不能回显输入结构。
  const publicMetadata: AuditMetadata[] = [result.audit[0]?.metadata as AuditMetadata, result.events[0]?.audit.metadata as AuditMetadata];
  for (const item of publicMetadata) {
    assert.ok(item);
    assert.equal('request' in item, false);
    assert.equal('systemPrompt' in item, false);
    assert.equal('candidateId' in item, false);
  }
  assert.deepEqual(result.events[0]?.audit, result.audit[0]);

  // JSON 公共结果仍可看到版本证据，但不能看到 Prompt、用户输入或 provider 原始异常。
  const publicText = JSON.stringify(result);
  assert.equal(publicText.includes('iar.intent-decision-prompt/v1'), true);
  for (const secret of ['You are the IAR intent decision model', 'systemPrompt', 'secret-candidate-id', 'user-input-secret', 'raw-provider-secret']) assert.equal(publicText.includes(secret), false, secret);
});

/*
 * fallback 不是第二个 backend 竞争，而是同 backend 的显式关系链。
 * primary 和 fallback 使用不同 provider key，避免按名称猜测路径。
 * observed 记录 profile 快照，因此顺序能证明真实调用顺序。
 * 两次 attempt 都必须生成 audit 和 event，不能只保留最终成功。
 * primary 的失败原因只能是稳定摘要，不能是异常正文。
 * fallbackUsed 是逐条字段，不能从数组位置推断。
 * Intent fallback 还必须保留固定 Prompt 版本。
 */
/** fallback 的 JEV 和 Intent Model 都必须记录真实 primary/fallback 顺序及版本证据。 */
test('preserves ordered audit evidence for JEV and Intent Model fallback', async () => {
  for (const backend of ['jev', 'intent-model'] as const) {
    const observed: Array<{ profileId: string; input: JsonValue }> = [];
    const primary = profile(`${backend}-primary`, 'function.select', backend, `${backend}-fallback`);
    const fallback = profile(`${backend}-fallback`, 'function.select', backend);
    const profiles = new ModelProfileRegistry([primary, fallback]);
    const primaryProvider = observingProvider(observed, async () => { throw new Error(`${backend}-primary-secret`); });
    const fallbackProvider = observingProvider(observed, async (input) => decision(input));
    const providers = { [primary.provider]: primaryProvider, [fallback.provider]: fallbackProvider };
    const gateway = new ModelGateway({ registry: profiles, providers });
    const adapter = backend === 'jev' ? new JevDecisionAdapter(gateway, 'function.select') : new IntentModelDecisionAdapter(gateway, 'function.select');
    const result = await adapter.decide({ traceId: `trace-fallback-${backend}`, runId: `run-fallback-${backend}`, request: request() });

    // 真实 provider 映射必须产生 primary -> fallback 的可观察顺序。
    assert.equal(result.ok, true);
    assert.deepEqual(observed.map((entry) => entry.profileId), [primary.profileId, fallback.profileId]);
    assert.equal(result.audit.length, 2);
    assert.equal(result.events.length, 2);
    if (!result.ok) return;
    assertDecisionValue(result.value, 'function.select', ['candidate-1', 'candidate-2']);

    /*
     * profileId、profileVersion、modelId 和 modelVersion 是回溯证据。
     * metadata 的 provider 字段必须对应同一条 audit 的 profile。
     * JEV 不应伪造 promptVersion，Intent 则必须提供它。
     * 两条 event.audit 必须按索引与 audit 对齐。
     * 显式长度断言先于 map，确保断言不会在空数组上假阳性。
     */
    // 每一条 audit 都同时锁定 profile/model/version、fallback 标识和 metadata。
    const expectedPrimaryMetadata: AuditMetadata = {
      provider: primary.provider,
      candidateCount: 2,
      decisionBackend: backend,
      reason: '模型 provider 调用失败'
    };
    const expectedFallbackMetadata: AuditMetadata = { provider: fallback.provider, candidateCount: 2, decisionBackend: backend };
    if (backend === 'intent-model') {
      expectedPrimaryMetadata.promptVersion = 'iar.intent-decision-prompt/v1';
      expectedFallbackMetadata.promptVersion = 'iar.intent-decision-prompt/v1';
    }
    assert.deepEqual(result.audit.map((entry) => ({ profileId: entry.profileId, profileVersion: entry.profileVersion, modelId: entry.modelId, modelVersion: entry.modelVersion, fallbackUsed: entry.fallbackUsed })), [
      { profileId: primary.profileId, profileVersion: primary.profileVersion, modelId: primary.modelId, modelVersion: primary.modelVersion, fallbackUsed: false },
      { profileId: fallback.profileId, profileVersion: fallback.profileVersion, modelId: fallback.modelId, modelVersion: fallback.modelVersion, fallbackUsed: true }
    ]);
    assert.deepEqual(result.audit.map((entry) => entry.metadata), [expectedPrimaryMetadata, expectedFallbackMetadata]);

    // 逐条对齐 event.audit，避免空数组上的 every 断言产生假阳性。
    assert.deepEqual(result.events.map((event) => event.audit), result.audit);
    assert.deepEqual(result.events.map((event) => ({ eventName: event.eventName, errorCode: event.errorCode })), [
      { eventName: 'model.failed', errorCode: 'model.provider_failed' },
      { eventName: 'model.completed', errorCode: undefined }
    ]);
    /* 两次 provider 都失败时，公开错误只能携带稳定 code，且两条 attempt 仍完整可审计。 */
    const failedObserved: Array<{ profileId: string; input: JsonValue }> = [];
    const failedProviders = { [primary.provider]: observingProvider(failedObserved, async () => { throw new Error(`${backend}-primary-secret`); }), [fallback.provider]: observingProvider(failedObserved, async () => { throw new Error(`${backend}-fallback-secret`); }) };
    const failedGateway = new ModelGateway({ registry: profiles, providers: failedProviders }); const failedAdapter = backend === 'jev' ? new JevDecisionAdapter(failedGateway, 'function.select') : new IntentModelDecisionAdapter(failedGateway, 'function.select');
    const failed = await failedAdapter.decide({ traceId: `trace-double-failure-${backend}`, runId: `run-double-failure-${backend}`, request: request() });
    assert.equal(failed.ok, false);
    assert.deepEqual(failed.ok ? undefined : failed.error, { code: 'model.fallback_failed', message: '模型主 provider 和 fallback 均失败', retryable: false, details: { primaryCode: 'model.provider_failed', fallbackCode: 'model.provider_failed' } });
    assert.deepEqual(failedObserved.map((entry) => entry.profileId), [primary.profileId, fallback.profileId]);
    assert.equal(failed.audit.length, 2); assert.equal(failed.events.length, 2);
    assert.deepEqual(failed.audit.map((entry) => ({ profileId: entry.profileId, fallbackUsed: entry.fallbackUsed, outcome: entry.outcome })), [{ profileId: primary.profileId, fallbackUsed: false, outcome: 'provider_failed' }, { profileId: fallback.profileId, fallbackUsed: true, outcome: 'provider_failed' }]);
    assert.deepEqual(failed.events.map((event) => event.eventName), ['model.failed', 'model.failed']); assert.deepEqual(failed.events.map((event) => event.audit), failed.audit);
    assert.deepEqual(failed.audit.map((entry) => entry.metadata), [expectedPrimaryMetadata, { ...expectedFallbackMetadata, reason: '模型 provider 调用失败' }]);
  }
});

/*
 * invalid request 在 provider 之前失败，因此不应创建 audit。
 * no-profile 是配置错误，也不能凭空制造 profile/model 版本。
 * 两种稳定错误都必须保持空的 audit 和 events。
 * 这两个路径不涉及模型调用或 fallback。
 * error.details 固定为空对象，避免把内部配置细节公开。
 * 测试保留 provider 计数，确认 invalid 没有越过输入门禁。
 * 这组证据不触碰同步 runtime 或 Task 3 路由行为。
 */
/** invalid/no-profile 只能返回稳定错误，并且不能伪造 audit 或 event。 */
test('keeps invalid and no-profile results stable without fake audit', async () => {
  const observed: Array<{ profileId: string; input: JsonValue }> = [];
  const profiles = new ModelProfileRegistry([profile('intent-primary', 'function.select', 'intent-model')]);
  const invalid = await unified('function.select', profiles, { 'intent-primary-provider': observingProvider(observed) }).decide({ traceId: 'trace-invalid', runId: 'run-invalid', request: { ...request(), candidates: [] } });
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.audit, []); assert.deepEqual(invalid.events, []);
  assert.equal(observed.length, 0);
  if (!invalid.ok) assert.deepEqual(invalid.error, { code: 'model.invalid_request', message: '统一 decision request 无效', retryable: false, details: {} });
  const noProfileRegistry = new ModelProfileRegistry([profile('semantic', 'semantic.extract')]);
  const noProfile = await unified('function.select', noProfileRegistry, {}).decide({ traceId: 'trace-no-profile', runId: 'run-no-profile', request: request() });
  assert.equal(noProfile.ok, false);
  assert.deepEqual(noProfile.audit, []); assert.deepEqual(noProfile.events, []);
  assert.deepEqual(noProfile.ok ? undefined : noProfile.error, { code: 'model.no_profile', message: MODEL_NO_PROFILE_MESSAGE, retryable: false, details: {} });
});
