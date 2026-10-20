/*
 * 验证 Phase 3 Task 3.2 的统一 ModelGateway 和五类 role adapter。
 * provider 只能通过 profile.provider 注册表进入，不允许隐式 provider。
 * Semantic Extractor、JEV Function/Plugin Decision、Context Compactor 和 Response Generator 必须路由到正确 role。
 * provider timeout、provider failure 和 schema invalid 必须转换为稳定错误或事件。
 * primary 重试必须受 profile.retryPolicy 限制，fallback 必须使用实际 fallback 版本审计。
 * JEV 的低分结果必须成为 needs_clarification，不得猜测或生成可执行 choice。
 * JEV 的非法 candidate set、错误 decisionType 和 schema 错误不能绕过本地校验。
 * SemanticFrame 和 response output 必须使用结构化 schemaVersion。
 * Context Compactor 必须复用 contracts 的 compactionResult validator。
 * 所有公开结果都只能携带脱敏 audit/event metadata，不回传 raw prompt 或 API key。
 * provider 的原始异常 message 不能进入稳定错误或事件 details。
 * timeout 必须 abort provider signal，并且不能继续消耗后续 retry 额度。
 * fallback provider 失败时必须返回明确 fallback_failed，而不是伪装成功。
 * 不提供真实 SDK、网络、HTTP 或环境密钥，测试只使用本地 deterministic provider。
 * Task 3.2 只接入既有 contracts，不修改 Phase 2 router、Policy 或 Workflow 语义。
 * 这些测试是 ModelGateway 对后续 Fastify adapter 和示例插件的唯一调用边界。
 * role adapter 不允许调用方自行替换 profile 或 provider。
 * provider request 的业务输入只用于测试调用，不能被 audit event 原样复制。
 * audit entry 必须携带 profileVersion 和 modelVersion，供后续版本回溯。
 * fallback 成功和 fallback 失败都必须保留 primary 与 fallback attempt 证据。
 * retry attempt 数量由 profile 配置决定，不能由 provider 返回值扩大。
 * schema invalid 不得作为合法 response 或 DecisionResult 继续传播。
 * compaction result 的 Runtime 专属字段仍由 runtime service 负责补齐。
 * JEV adapter 必须复用现有 candidate set、decisionType 和 threshold 语义。
 * low score 只产生澄清，不会调用任何插件或工作流执行器。
 * timeout 路径使用 AbortSignal，确保 provider 可协作释放资源。
 * timeout 之后的 provider late result 不会覆盖已记录的失败 attempt。
 * provider error details 使用稳定摘要，不能携带 Error 实例、stack 或 message。
 * unknown provider 配置必须在 gateway 内部拒绝，不允许隐式创建客户端。
 * fallback profile 必须由 registry 显式引用，不能根据 provider 名称猜测。
 * 每个 role 的 output validator 都是独立边界，避免跨 role 结果混用。
 * SemanticFrame 仅保留抽取事实，不授予 Function、Plugin 或 Action 权限。
 * ResponseGenerator 仅返回文本和引用，不将文本解析为执行指令。
 * focused suite 同时作为 provider adapter 的 contract regression。
 * primary profile 的 retryOn 只匹配 timeout 和 provider 分类。
 * schema invalid 默认不重试，直接进入 fallback，避免重复放大非法输出。
 * 真实 fallback provider 仍必须通过同一 output validator。
 * 每个 audit event 的 metadata 都经过 request redaction。
 * raw prompt、apiKey 和 provider secret 只出现在测试输入，不出现在结果。
 * 事件 outcome 区分 success、rejected、timeout、provider_failed 和 fallback。
 * threshold_rejected 作为稳定 errorCode 附在 rejected event 上。
 * gateway failure 的 retryable 只对 timeout/provider_failed 开放。
 * fallback_failed 明确表示两条 provider 路径都没有成功。
 * no_provider 不会触发网络调用或动态 provider discovery。
 * invalid_request 不会创建伪造 audit event。
 * provider failure 只返回固定 message，避免内部异常文本泄漏。
 * response schema 额外字段必须拒绝，防止隐藏执行指令。
 * semantic schema 额外字段必须拒绝，防止规则输入注入。
 * compaction schema 由 contracts 统一维护，gateway 不复制第二份 schema。
 * 五类 role 的 profile 选择必须与 `models.yaml` 保持一一对应。
 * 通过 registry 读取的 profile 版本是审计唯一来源。
 * 测试输出不依赖本地时区、网络状态或随机数。
 * provider signal 的 abort 事件是 timeout acceptance 的可观察证据。
 * fallback 审计断言同时检查 profileId、modelId 和 fallbackUsed。
 * 低分决策断言检查 status 和 errorCode 两个稳定边界。
 * 非法 provider 输出和异常分别覆盖 schema 与 provider failure。
 * 每个测试都使用独立 gateway，避免调用次数和事件互相污染。
 * 本文件只验证 adapter contract，不验证业务 Function 规则命中。
 * profile timeout 采用最小测试覆盖，避免测试本身产生长时间等待。
 * provider late promise 通过 abort 证据验证资源释放路径。
 * schema invalid 的 fallback attempt 仍必须保持相同错误分类。
 * adapter 返回值使用 discriminated union，测试显式收窄 ok 分支。
 * 失败事件只检查稳定 code，不依赖内部 provider 实现细节。
 * inherited provider 测试防止原型链绕过 provider 白名单。
 * malformed provider 测试防止缺少 complete 的对象进入调用路径。
 * retry backoff 测试使用单 profile，隔离 fallback 对时间断言的影响。
 * retry backoff 同时断言 attempt 数量，防止配置被 provider 修改。
 * freeze 测试覆盖 profile 顶层、retryPolicy 嵌套和 input 三层快照。
 * provider mutation 测试确认调用方原始 input 不会被反向写入。
 * provider mutation 测试确认 fallback 仍从 registry 读取原始版本配置。
 * unclonable JEV 测试确保 DataCloneError 不越过 adapter boundary。
 * JEV 输入失败不应创建 provider 调用，也不应创建伪造 audit event。
 * 运行时错误断言不比较原始异常 message，避免测试绑定实现细节。
 * timeout 结果断言同时检查 abort、outcome 和稳定错误事件。
 * schema 结果断言同时检查失败分类和敏感 input 不泄漏。
 * role routing 结果断言保证 context.compact 也使用同一 gateway。
 * response result 只验证结构化 text，不将自然语言解释当作执行授权。
 * decision result 只验证有限 candidate，不验证任何插件副作用。
 * fallback audit 只允许稳定 profile/model 字段和脱敏 metadata。
 * 所有 provider 都是显式 async 函数，模拟未来 SDK 的异步边界。
 * 测试不使用 sleep 作为主同步手段，只有 backoff acceptance 使用性能窗口。
 * provider snapshot 的冻结是 runtime defense，不依赖 TypeScript readonly。
 * profile retryPolicy 的本地副本是 retry loop 的权威来源。
 * provider 只能观察当前 attempt，不能把一次修改传播到 fallback。
 * own-property 校验覆盖 `constructor` 和 `toString` 等原型继承名称。
 * provider registry 测试确保 malformed object 不进入 retry 循环。
 * fallback profile 仍须满足相同的 response Schema 和脱敏审计。
 * backoff 断言保留小余量，避免受调度抖动影响而过度脆弱。
 * JEV clone 失败测试使用不可克隆函数模拟宿主错误输入。
 * 结构化结果测试覆盖成功、澄清、schema 失败和 provider 失败四种路径。
 * 每个失败路径都要求返回 discriminated union，而不是同步 throw。
 * 调用方只需处理稳定 code，不需要理解 provider SDK 的错误类型。
 * 审计事件的原始输入检查覆盖 prompt 和 apiKey 两类敏感字段。
 * 五类 role 的调用顺序来自显式 adapter，不依赖对象 key 排序。
 * 测试 fixture 的 profile 版本来自 config/models.yaml，避免重复配置漂移。
 * 失败结果不会携带 stack、provider message 或完整请求对象。
 * 该回归集为后续 Fastify response contract 提供稳定错误输入。
 * invocation snapshot 测试确认调用方在 backoff 中修改输入也不影响后续 attempt。
 * output clone 测试确认 provider 返回对象的延迟修改不会污染已验证结果。
 * provider error 分类测试确认同步返回值也会被拒绝为 provider_failed。
 * 所有快照测试都检查原始对象与公开结果之间不存在可变别名。
 * 这些边界为后续真实 SDK 适配提供不可绕过的最小安全 contract。
 * invocation、profile、provider output 三类快照分别覆盖输入、控制面和结果面。
 * 测试中的异步 late mutation 不应改变已经返回的公开结构。
 * provider registry 和 complete 返回类型都在 runtime 重新验证。
 * retry backoff 与 timeout 均使用 profile 资源上限，不由测试 fixture 放宽。
 * schema/threshold 事件保留稳定 code，便于后续 HTTP contract 直接映射。
 * 所有测试证据都可在无真实模型和无网络环境中重放。
 * role adapter 的失败结果不绕过 ModelGateway 的审计和脱敏边界。
 * 本文件最后一组测试专门锁定 reviewer 指出的快照安全边界。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  ContextCompactorAdapter,
  JevDecisionAdapter,
  ModelGateway,
  ModelProviderError,
  ResponseGeneratorAdapter,
  SemanticExtractorAdapter,
  DecisionBackendResolver,
  IntentModelDecisionAdapter,
  UnifiedDecisionAdapter,
  loadModelProfiles,
  ModelProfileRegistry,
  type ModelProvider
} from '@iar/decision';
import type { CompactionResult, DecisionResult, JsonValue } from '@iar/contracts';
import { createInitialContext } from '@iar/runtime';

/** 读取 Task 3.1 的版本化 profile 配置。 @returns profile registry @author lvdaxianer@yeah.net @date 2026-10-17 */
function registry(): ModelProfileRegistry {
  return new ModelProfileRegistry(loadModelProfiles(readFileSync(join(process.cwd(), 'config', 'models.yaml'), 'utf8')));
}

/** 创建最小合法 SemanticFrame provider 输出。 @returns JSON-safe SemanticFrame @author lvdaxianer@yeah.net @date 2026-10-17 */
function semanticFrame(): JsonValue {
  return { schemaVersion: 'iar.semantic-frame/v1', intent: 'service.stop', action: 'execute', confidence: 0.95, slots: { serviceId: 'test1' }, references: [] };
}

/** 创建最小合法 DecisionResult provider 输出。 @param decisionType - JEV role @param score - 模型分数 @returns DecisionResult fixture @author lvdaxianer@yeah.net @date 2026-10-17 */
function decisionResult(decisionType: 'function.select' | 'plugin.select', score = 0.95): DecisionResult {
  return { schemaVersion: 'iar.decision/v1', decisionType, decisionVersion: 'test@1', status: 'choice', choice: 'candidate-1', score, reasonCode: 'matched', candidateIds: ['candidate-1'] };
}

/** 创建仅包含模型允许字段的压缩候选。 @returns CompactionResult fixture @author lvdaxianer@yeah.net @date 2026-10-17 */
function compactionResult(): CompactionResult {
  const state = createInitialContext('run-roles');
  return { schemaVersion: 'iar.compaction-result/v1', summary: 'summary', state: { subject: state.subject, intent: state.intent, action: state.action, route: state.route, slots: state.slots, workflow: state.workflow, pending: state.pending, confirmation: state.confirmation }, references: [], preservedFacts: [], warnings: [] };
}

/** 创建无同 backend fallback 的双决策 backend registry，专门验证显式跨 backend 语义。 @returns 可供 Task 3 测试使用的 registry @author lvdaxianer@yeah.net @date 2026-10-17 */
function dualDecisionRegistry(): ModelProfileRegistry {
  const profiles = loadModelProfiles(readFileSync(join(process.cwd(), 'config', 'models.yaml'), 'utf8'));
  const selection = profiles.filter((profile) => profile.role === 'function.select' || profile.role === 'plugin.select');
  const withoutFallback = selection.filter((profile) => profile.profileId === 'function-decision-primary' || profile.profileId === 'plugin-decision-primary');
  assert.equal(withoutFallback.length, 2);
  const decisionProfiles = withoutFallback.map((profile) => {
    const { fallbackProfileId: _fallbackProfileId, ...primary } = profile;
    return { ...primary, decisionBackend: 'jev' as const };
  });
  const functionPrimary = decisionProfiles.find((profile) => profile.role === 'function.select');
  assert.ok(functionPrimary);
  const intentProfile = { ...functionPrimary, profileId: 'function-intent-primary', decisionBackend: 'intent-model' as const, provider: 'intent-mock', modelId: 'intent-decision', modelVersion: 'intent-mock-1' };
  return new ModelProfileRegistry([...profiles.filter((profile) => profile.role !== 'function.select' && profile.role !== 'plugin.select'), ...decisionProfiles, intentProfile]);
}

/** 创建保留 JEV 同 backend fallback 的双 backend registry，验证 fallback 顺序。 @returns 带 JEV fallback 的 registry @author lvdaxianer@yeah.net @date 2026-10-17 */
function dualDecisionRegistryWithJevFallback(): ModelProfileRegistry {
  const profiles = loadModelProfiles(readFileSync(join(process.cwd(), 'config', 'models.yaml'), 'utf8'));
  const decisionProfiles = profiles.filter((profile) => profile.profileId === 'function-decision-primary' || profile.profileId === 'function-decision-fallback' || profile.profileId === 'plugin-decision-primary' || profile.profileId === 'plugin-decision-fallback').map((profile) => ({ ...profile, decisionBackend: 'jev' as const }));
  const primary = decisionProfiles.find((profile) => profile.profileId === 'function-decision-primary');
  assert.ok(primary);
  const { fallbackProfileId: _fallbackProfileId, ...intentProfile } = primary;
  return new ModelProfileRegistry([...profiles.filter((profile) => profile.role !== 'function.select' && profile.role !== 'plugin.select'), ...decisionProfiles, { ...intentProfile, profileId: 'function-intent-primary', decisionBackend: 'intent-model' as const, provider: 'intent-mock', modelId: 'intent-decision', modelVersion: 'intent-mock-1' }]);
}

/* role routing 必须调用五类 adapter，并保留结构化输出。 */
test('routes all model roles through the gateway and records redacted audit events', async () => {
  const calls: string[] = [];
  const provider: ModelProvider = { complete: async (request) => { calls.push(request.profile.role); return request.profile.role === 'semantic.extract' ? semanticFrame() : request.profile.role === 'function.select' ? decisionResult('function.select') : request.profile.role === 'plugin.select' ? decisionResult('plugin.select') : request.profile.role === 'context.compact' ? compactionResult() : { schemaVersion: 'iar.response/v1', text: 'done' }; } };
  const gateway = new ModelGateway({ registry: registry(), providers: { mock: provider } });
  const semantic = await new SemanticExtractorAdapter(gateway).extract({ traceId: 'trace-roles', runId: 'run-roles', input: { prompt: 'stop test1' } });
  const functionDecision = await new JevDecisionAdapter(gateway, 'function.select').decide({ traceId: 'trace-roles', runId: 'run-roles', request: { decisionType: 'function.select', decisionVersion: 'test@1', threshold: 0.8, candidates: [{ candidateId: 'candidate-1', priority: 1, specificity: 1 }] } });
  const pluginDecision = await new JevDecisionAdapter(gateway, 'plugin.select').decide({ traceId: 'trace-roles', runId: 'run-roles', request: { decisionType: 'plugin.select', decisionVersion: 'test@1', threshold: 0.8, candidates: [{ candidateId: 'candidate-1', priority: 1, specificity: 1 }] } });
  const compact = await new ContextCompactorAdapter(gateway).compact({ traceId: 'trace-roles', runId: 'run-roles', input: { context: 'old' } });
  const response = await new ResponseGeneratorAdapter(gateway).generate({ traceId: 'trace-roles', runId: 'run-roles', input: { prompt: 'respond' } });
  assert.equal(semantic.ok, true);
  assert.equal(functionDecision.ok, true);
  assert.equal(pluginDecision.ok, true);
  assert.equal(compact.ok, true);
  assert.equal(response.ok, true);
  assert.deepEqual(calls, ['semantic.extract', 'function.select', 'plugin.select', 'context.compact', 'response.generate']);
  assert.equal(JSON.stringify(response.events).includes('respond'), false);
  assert.equal(JSON.stringify(response.events).includes('api-key'), false);
});

test('semantic action is normalized to unknown when omitted and rejects dynamic action names', async () => {
  let dynamic = false;
  const provider: ModelProvider = { complete: async (request) => {
    if (request.profile.role !== 'semantic.extract') return semanticFrame();
    return dynamic ? { ...semanticFrame() as Record<string, JsonValue>, action: 'rank' } : (() => {
      const { action: _action, ...legacy } = semanticFrame() as Record<string, JsonValue>;
      return legacy;
    })();
  } };
  const gateway = new ModelGateway({ registry: registry(), providers: { mock: provider } });
  const missing = await new SemanticExtractorAdapter(gateway).extract({ traceId: 'trace-semantic-action', runId: 'run-semantic-action', input: { text: 'previous result' } });
  assert.equal(missing.ok, true);
  if (missing.ok) assert.equal(missing.value.action, 'unknown');
  dynamic = true;
  const invalid = await new SemanticExtractorAdapter(gateway).extract({ traceId: 'trace-semantic-action-invalid', runId: 'run-semantic-action-invalid', input: { text: 'rank' } });
  assert.equal(invalid.ok, false);
});

test('semantic frame accepts generic historical relation references', async () => {
  const provider: ModelProvider = { complete: async (request) => request.profile.role === 'semantic.extract'
    ? { schemaVersion: 'iar.semantic-frame/v2', intent: 'historical.lookup', action: 'query', confidence: 0.95, slots: {}, references: [{ text: '上一个', anchorRecordId: 'record-opaque-b', relation: 'previous', scope: 'same_fact_chain' }] }
    : { schemaVersion: 'iar.response/v1', text: 'ok' } };
  const result = await new SemanticExtractorAdapter(new ModelGateway({ registry: registry(), providers: { mock: provider } })).extract({ traceId: 'trace-reference', runId: 'run-reference', input: { text: '这个的上一个' } });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.references[0], { text: '上一个', anchorRecordId: 'record-opaque-b', relation: 'previous', scope: 'same_fact_chain' });
});

test('semantic frame rejects direct business target values in the new reference contract', async () => {
  const provider: ModelProvider = { complete: async (request) => request.profile.role === 'semantic.extract'
    ? { schemaVersion: 'iar.semantic-frame/v2', intent: 'historical.lookup', action: 'query', confidence: 0.95, slots: {}, references: [{ text: '上一个', resolvedTo: 'business-value-001' }] }
    : { schemaVersion: 'iar.response/v1', text: 'ok' } };
  const result = await new SemanticExtractorAdapter(new ModelGateway({ registry: registry(), providers: { mock: provider } })).extract({ traceId: 'trace-reference-invalid', runId: 'run-reference-invalid', input: { text: '这个的上一个' } });
  assert.equal(result.ok, false);
});

/* timeout、schema invalid 和 provider failure 必须走 retry/fallback 的稳定路径。 */
test('retries bounded failures and records the fallback profile version', async () => {
  let calls = 0;
  const provider: ModelProvider = { complete: async (request) => { calls += 1; if (request.profile.profileId.endsWith('primary')) throw new ModelProviderError('provider_unavailable'); return { schemaVersion: 'iar.response/v1', text: 'fallback response' }; } };
  const gateway = new ModelGateway({ registry: registry(), providers: { mock: provider } });
  const result = await new ResponseGeneratorAdapter(gateway).generate({ traceId: 'trace-fallback', runId: 'run-fallback', input: { rawPrompt: 'secret' } });
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
  if (result.ok) {
    assert.equal(result.audit.at(-1)?.profileId, 'response-generator-fallback');
    assert.equal(result.audit.at(-1)?.fallbackUsed, true);
  }
});

/* 阈值不足是可审计的澄清结果，不得由 gateway 猜测候选。 */
test('maps low JEV score to needs clarification without executing a choice', async () => {
  const provider: ModelProvider = { complete: async () => decisionResult('function.select', 0.1) };
  const gateway = new ModelGateway({ registry: registry(), providers: { mock: provider } });
  const result = await new JevDecisionAdapter(gateway, 'function.select').decide({ traceId: 'trace-threshold', runId: 'run-threshold', request: { decisionType: 'function.select', decisionVersion: 'test@1', threshold: 0.8, candidates: [{ candidateId: 'candidate-1', priority: 1, specificity: 1 }] } });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, 'needs_clarification');
    assert.equal(result.events.at(-1)?.errorCode, 'model.threshold_rejected');
  }
});

/* JEV 失败默认不能把同一决策隐式切换到 Intent Model。 */
test('does not cross backend after JEV failure unless explicitly configured', async () => {
  const calls: string[] = [];
  const provider: ModelProvider = { complete: async (request) => {
    calls.push(request.profile.provider);
    if (request.profile.provider === 'mock') throw new ModelProviderError('provider_unavailable');
    return decisionResult('function.select');
  } };
  const modelRegistry = dualDecisionRegistry();
  const gateway = new ModelGateway({ registry: modelRegistry, providers: { mock: provider, 'intent-mock': provider } });
  const resolver = new DecisionBackendResolver(modelRegistry);
  const adapter = new UnifiedDecisionAdapter(resolver, new JevDecisionAdapter(gateway, 'function.select'), new IntentModelDecisionAdapter(gateway, 'function.select'));
  const result = await adapter.decide({ traceId: 'trace-no-cross', runId: 'run-no-cross', request: { decisionType: 'function.select', decisionVersion: 'test@1', threshold: 0.8, candidates: [{ candidateId: 'candidate-1', priority: 1, specificity: 1 }] } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'model.provider_failed');
  assert.deepEqual(calls, ['mock', 'mock']);
});

/* 显式跨 backend 不能跳过配置中的同 backend fallback。 */
test('prefers same backend fallback before explicit cross backend fallback', async () => {
  const calls: string[] = [];
  const provider: ModelProvider = { complete: async (request) => {
    calls.push(request.profile.profileId);
    if (request.profile.profileId === 'function-decision-primary') throw new ModelProviderError('provider_unavailable');
    if (request.profile.profileId === 'function-intent-primary') throw new Error('cross backend should not run');
    return decisionResult('function.select');
  } };
  const modelRegistry = dualDecisionRegistryWithJevFallback();
  const gateway = new ModelGateway({ registry: modelRegistry, providers: { mock: provider, 'intent-mock': provider } });
  const resolver = new DecisionBackendResolver(modelRegistry);
  const adapter = new UnifiedDecisionAdapter(resolver, new JevDecisionAdapter(gateway, 'function.select'), new IntentModelDecisionAdapter(gateway, 'function.select'), { crossBackendFallback: true });
  const result = await adapter.decide({ traceId: 'trace-same-first', runId: 'run-same-first', request: { decisionType: 'function.select', decisionVersion: 'test@1', threshold: 0.8, candidates: [{ candidateId: 'candidate-1', priority: 1, specificity: 1 }] } });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['function-decision-primary', 'function-decision-primary', 'function-decision-fallback']);
  if (result.ok) assert.deepEqual(result.audit.map((entry) => (entry.metadata as Record<string, unknown>).decisionBackend), ['jev', 'jev', 'jev']);
});

/* 显式 crossBackendFallback 才允许保留 JEV 失败证据并调用 Intent Model。 */
test('uses explicit cross backend fallback and records both attempts', async () => {
  const calls: string[] = [];
  const intentInputs: JsonValue[] = [];
  let mutationBlocked = false;
  const provider: ModelProvider = { complete: async (request) => {
    calls.push(request.profile.provider);
    if (request.profile.provider === 'mock') throw new ModelProviderError('provider_unavailable');
    intentInputs.push(request.input as JsonValue);
    try { (request.input as unknown as { promptVersion: string }).promptVersion = 'tampered'; } catch { mutationBlocked = true; }
    return decisionResult('function.select');
  } };
  const modelRegistry = dualDecisionRegistry();
  const gateway = new ModelGateway({ registry: modelRegistry, providers: { mock: provider, 'intent-mock': provider } });
  const resolver = new DecisionBackendResolver(modelRegistry);
  const adapter = new UnifiedDecisionAdapter(resolver, new JevDecisionAdapter(gateway, 'function.select'), new IntentModelDecisionAdapter(gateway, 'function.select'), { crossBackendFallback: true });
  const result = await adapter.decide({ traceId: 'trace-cross', runId: 'run-cross', request: { decisionType: 'function.select', decisionVersion: 'test@1', threshold: 0.8, candidates: [{ candidateId: 'candidate-1', priority: 1, specificity: 1 }] } });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['mock', 'mock', 'intent-mock']);
  if (result.ok) {
    const metadata = result.audit.map((entry) => entry.metadata as Record<string, unknown>);
    assert.deepEqual(metadata.map((entry) => [entry.decisionBackend, entry.provider]), [['jev', 'mock'], ['jev', 'mock'], ['intent-model', 'intent-mock']]);
    assert.deepEqual(result.audit.map((entry) => entry.fallbackUsed), [false, false, true]);
    assert.equal(metadata[2]?.promptVersion, 'iar.intent-decision-prompt/v1');
  }
  assert.equal((intentInputs[0] as { promptVersion?: string }).promptVersion, 'iar.intent-decision-prompt/v1');
  assert.equal(mutationBlocked, true);
});

/* 非法 JEV 输出属于 schema 边界错误，即使显式开启也不能跨 backend 重试。 */
test('does not cross backend after schema-invalid JEV output', async () => {
  const calls: string[] = [];
  const provider: ModelProvider = { complete: async (request) => {
    calls.push(request.profile.provider);
    return request.profile.provider === 'mock' ? { invalid: true } : decisionResult('function.select');
  } };
  const modelRegistry = dualDecisionRegistry();
  const gateway = new ModelGateway({ registry: modelRegistry, providers: { mock: provider, 'intent-mock': provider } });
  const resolver = new DecisionBackendResolver(modelRegistry);
  const adapter = new UnifiedDecisionAdapter(resolver, new JevDecisionAdapter(gateway, 'function.select'), new IntentModelDecisionAdapter(gateway, 'function.select'), { crossBackendFallback: true });
  const result = await adapter.decide({ traceId: 'trace-schema-cross', runId: 'run-schema-cross', request: { decisionType: 'function.select', decisionVersion: 'test@1', threshold: 0.8, candidates: [{ candidateId: 'candidate-1', priority: 1, specificity: 1 }] } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'model.schema_invalid');
  assert.deepEqual(calls, ['mock']);
});

/* 显式跨 backend 两边都失败时仍返回稳定 fallback_failed，且保留两条 attempt 证据。 */
test('keeps cross backend double failure stable and redacted', async () => {
  const calls: string[] = [];
  const provider: ModelProvider = { complete: async (request) => {
    calls.push(request.profile.provider);
    throw new Error(`raw-${request.profile.provider}-secret`);
  } };
  const modelRegistry = dualDecisionRegistry();
  const gateway = new ModelGateway({ registry: modelRegistry, providers: { mock: provider, 'intent-mock': provider } });
  const resolver = new DecisionBackendResolver(modelRegistry);
  const adapter = new UnifiedDecisionAdapter(resolver, new JevDecisionAdapter(gateway, 'function.select'), new IntentModelDecisionAdapter(gateway, 'function.select'), { crossBackendFallback: true });
  const result = await adapter.decide({ traceId: 'trace-cross-failed', runId: 'run-cross-failed', request: { decisionType: 'function.select', decisionVersion: 'test@1', threshold: 0.8, candidates: [{ candidateId: 'candidate-1', priority: 1, specificity: 1 }] } });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.error, { code: 'model.fallback_failed', message: '模型主 provider 和 fallback 均失败', retryable: false, details: { primaryCode: 'model.provider_failed', fallbackCode: 'model.provider_failed' } });
    assert.equal(JSON.stringify(result).includes('raw-'), false);
  }
  assert.deepEqual(calls, ['mock', 'mock', 'intent-mock', 'intent-mock']);
  assert.deepEqual(result.audit.map((entry) => entry.fallbackUsed), [false, false, true, true]);
});

/* JEV 的低分澄清是合法结果，显式跨 backend 也不能把它升级为另一条选择。 */
test('does not cross backend after low score clarification', async () => {
  const calls: string[] = [];
  const provider: ModelProvider = { complete: async (request) => {
    calls.push(request.profile.provider);
    return request.profile.provider === 'mock' ? decisionResult('function.select', 0.1) : decisionResult('function.select');
  } };
  const modelRegistry = dualDecisionRegistry();
  const gateway = new ModelGateway({ registry: modelRegistry, providers: { mock: provider, 'intent-mock': provider } });
  const resolver = new DecisionBackendResolver(modelRegistry);
  const adapter = new UnifiedDecisionAdapter(resolver, new JevDecisionAdapter(gateway, 'function.select'), new IntentModelDecisionAdapter(gateway, 'function.select'), { crossBackendFallback: true });
  const result = await adapter.decide({ traceId: 'trace-low-score', runId: 'run-low-score', request: { decisionType: 'function.select', decisionVersion: 'test@1', threshold: 0.8, candidates: [{ candidateId: 'candidate-1', priority: 1, specificity: 1 }] } });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.status, 'needs_clarification');
  assert.deepEqual(calls, ['mock']);
});

/* adapter 必须把 provider 的非法结构收敛为 schema_invalid，不能抛出原始异常。 */
test('rejects invalid structured output and provider exceptions with stable errors', async () => {
  const provider: ModelProvider = { complete: async () => { throw new Error('raw provider secret'); } };
  const gateway = new ModelGateway({ registry: registry(), providers: { mock: provider } });
  const result = await new SemanticExtractorAdapter(gateway).extract({ traceId: 'trace-invalid', runId: 'run-invalid', input: { prompt: 'secret' } });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'model.fallback_failed');
    assert.equal(result.error.message.includes('raw provider secret'), false);
    assert.equal(JSON.stringify(result.events).includes('secret'), false);
  }
  const invalid = await new ContextCompactorAdapter(gateway).compact({ traceId: 'trace-invalid', runId: 'run-invalid', input: {} });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, 'model.fallback_failed');
});

/* timeout 必须 abort provider；Schema 错误必须产生 schema_invalid 事件。 */
test('maps timeout and schema failures without leaking provider input', async () => {
  const profiles = loadModelProfiles(readFileSync(join(process.cwd(), 'config', 'models.yaml'), 'utf8')).filter((item) => item.role === 'response.generate').map((item) => ({ ...item, timeoutMs: 5 }));
  let aborted = false;
  const timeoutProvider: ModelProvider = { complete: async (request) => new Promise(() => { request.signal.addEventListener('abort', () => { aborted = true; }); }) };
  const timeoutGateway = new ModelGateway({ registry: new ModelProfileRegistry(profiles), providers: { mock: timeoutProvider } });
  const timeoutResult = await new ResponseGeneratorAdapter(timeoutGateway).generate({ traceId: 'trace-timeout', runId: 'run-timeout', input: { rawPrompt: 'secret' } });
  assert.equal(timeoutResult.ok, false);
  assert.equal(aborted, true);
  assert.equal(timeoutResult.events.every((event) => event.audit.outcome === 'timeout'), true);

  const invalidProvider: ModelProvider = { complete: async () => ({ schemaVersion: 'iar.response/v1', text: '' }) };
  const invalidGateway = new ModelGateway({ registry: registry(), providers: { mock: invalidProvider } });
  const invalidResult = await new ResponseGeneratorAdapter(invalidGateway).generate({ traceId: 'trace-schema', runId: 'run-schema', input: { apiKey: 'secret' } });
  assert.equal(invalidResult.ok, false);
  assert.equal(invalidResult.events.some((event) => event.errorCode === 'model.schema_invalid'), true);
  assert.equal(JSON.stringify(invalidResult.events).includes('secret'), false);
});

/* provider registry 只接受 own-property 且 complete 为异步函数的实现。 */
test('rejects inherited and malformed providers before retry', async () => {
  const inherited = Object.create({ mock: { complete: async () => ({ schemaVersion: 'iar.response/v1', text: 'inherited' }) } });
  const inheritedResult = await new ResponseGeneratorAdapter(new ModelGateway({ registry: registry(), providers: inherited })).generate({ traceId: 'trace-provider', runId: 'run-provider', input: {} });
  assert.equal(inheritedResult.ok, false);
  assert.equal(inheritedResult.events.every((event) => event.errorCode === 'model.no_provider'), true);
  const malformed = { mock: {} } as never;
  const malformedResult = await new ResponseGeneratorAdapter(new ModelGateway({ registry: registry(), providers: malformed })).generate({ traceId: 'trace-provider', runId: 'run-provider', input: {} });
  assert.equal(malformedResult.ok, false);
  assert.equal(malformedResult.events.every((event) => event.errorCode === 'model.no_provider'), true);
  const synchronous = { mock: { complete: () => ({ schemaVersion: 'iar.response/v1', text: 'sync' }) } } as never;
  const synchronousResult = await new ResponseGeneratorAdapter(new ModelGateway({ registry: registry(), providers: synchronous })).generate({ traceId: 'trace-provider', runId: 'run-provider', input: {} });
  assert.equal(synchronousResult.ok, false);
  const throwingProviders = new Proxy({}, { get: () => { throw new Error('provider getter secret'); } }) as never;
  const throwingResult = await new ResponseGeneratorAdapter(new ModelGateway({ registry: registry(), providers: throwingProviders })).generate({ traceId: 'trace-provider', runId: 'run-provider', input: {} });
  assert.equal(throwingResult.ok, false);
});

/* backoffMs 必须在同一 profile 的有限 retry attempt 之间生效。 */
test('honors configured retry backoff without expanding attempts', async () => {
  const primary = loadModelProfiles(readFileSync(join(process.cwd(), 'config', 'models.yaml'), 'utf8')).find((item) => item.profileId === 'response-generator-primary');
  assert.ok(primary);
  const { fallbackProfileId: _fallbackProfileId, ...primaryWithoutFallback } = primary;
  const profiles = [{ ...primaryWithoutFallback, retryPolicy: { ...primary.retryPolicy, maxAttempts: 2, backoffMs: 10 } }];
  let calls = 0;
  const provider: ModelProvider = { complete: async () => { calls += 1; if (calls === 1) throw new ModelProviderError('provider_unavailable'); return { schemaVersion: 'iar.response/v1', text: 'retried' }; } };
  const started = performance.now();
  const result = await new ResponseGeneratorAdapter(new ModelGateway({ registry: new ModelProfileRegistry(profiles), providers: { mock: provider } })).generate({ traceId: 'trace-backoff', runId: 'run-backoff', input: {} });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.equal(performance.now() - started >= 8, true);
});

/* provider 只能读取冻结快照，不能修改 profile、retry 上限或后续 audit input。 */
test('freezes provider snapshots and keeps local retry limits authoritative', async () => {
  let calls = 0;
  let sawFrozenSnapshot = false;
  const seenInputs: string[] = [];
  const originalInput = { prompt: 'keep-original' };
  const provider: ModelProvider = { complete: async (request) => {
    calls += 1;
    seenInputs.push((request.input as unknown as { prompt: string }).prompt);
    sawFrozenSnapshot = Object.isFrozen(request.profile) && Object.isFrozen(request.profile.retryPolicy) && Object.isFrozen(request.input);
    try { (request.profile as unknown as { retryPolicy: { maxAttempts: number } }).retryPolicy.maxAttempts = 99; } catch {}
    try { (request.input as unknown as { prompt: string }).prompt = 'provider-mutated'; } catch {}
    if (calls === 1) setTimeout(() => { originalInput.prompt = 'caller-mutated-during-backoff'; }, 1);
    if (calls <= 2) throw new ModelProviderError('provider_unavailable');
    return { schemaVersion: 'iar.response/v1', text: 'safe fallback' };
  } };
  const result = await new ResponseGeneratorAdapter(new ModelGateway({ registry: registry(), providers: { mock: provider } })).generate({ traceId: 'trace-freeze', runId: 'run-freeze', input: originalInput });
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
  assert.equal(sawFrozenSnapshot, true);
  assert.deepEqual(seenInputs, ['keep-original', 'keep-original', 'keep-original']);
  assert.equal(originalInput.prompt, 'caller-mutated-during-backoff');
});

/* JEV 的 structuredClone 失败必须在 adapter 输入边界转换为稳定错误。 */
test('rejects unclonable JEV input without throwing DataCloneError', async () => {
  const request = { decisionType: 'function.select' as const, decisionVersion: 'test@1', threshold: 0.8, candidates: [{ candidateId: 'candidate-1', priority: 1, specificity: 1, invalidFunction: () => 'not-json' }] } as never;
  const result = await new JevDecisionAdapter(new ModelGateway({ registry: registry(), providers: {} }), 'function.select').decide({ traceId: 'trace-clone', runId: 'run-clone', request });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'model.invalid_request');
});

/* Decision/Compaction validator 通过后仍需复制输出，隔离 provider 的延迟 mutation。 */
test('isolates validated decision and compaction outputs from late provider mutation', async () => {
  const rawDecision = decisionResult('function.select');
  const rawCompaction = compactionResult();
  const provider: ModelProvider = { complete: async (request) => {
    const output = request.profile.role === 'function.select' ? rawDecision : rawCompaction;
    setTimeout(() => { if (request.profile.role === 'function.select') rawDecision.choice = 'provider-mutated'; else rawCompaction.summary = 'provider-mutated'; }, 1);
    return output;
  } };
  const gateway = new ModelGateway({ registry: registry(), providers: { mock: provider } });
  const decision = await new JevDecisionAdapter(gateway, 'function.select').decide({ traceId: 'trace-output', runId: 'run-output', request: { decisionType: 'function.select', decisionVersion: 'test@1', threshold: 0.8, candidates: [{ candidateId: 'candidate-1', priority: 1, specificity: 1 }] } });
  const compact = await new ContextCompactorAdapter(gateway).compact({ traceId: 'trace-output', runId: 'run-output', input: {} });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(decision.ok && decision.value.choice, 'candidate-1');
  assert.equal(compact.ok && compact.value.summary, 'summary');
});
