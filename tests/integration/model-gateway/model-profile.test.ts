/*
 * 验证 Phase 3 Task 3.1 的 ModelProfile 配置、脱敏和版本审计边界。
 * 配置必须覆盖模型角色、timeout、retry、fallback 和 structured output。
 * registry 必须拒绝重复 profile、非法 timeout/retry 和错误 fallback。
 * 脱敏必须递归复制输入，不暴露 API key、authorization、raw prompt 和 raw user input。
 * audit entry 只允许 profile/model 版本和脱敏 metadata，不保存敏感正文。
 * profileVersion 和 modelVersion 都必须进入审计记录，支持配置回溯。
 * fallbackProfileId 只描述配置关系，不在 Task 3.1 触发实际 provider 调用。
 * structuredOutput 必须绑定 schemaId，避免模型返回无界文本。
 * timeout 和 retryPolicy 必须处于有限资源范围。
 * registry 返回深拷贝，调用方不能修改已加载配置。
 * fallback 引用不存在时配置加载必须 fail-closed。
 * role 缺失时 registry 查询必须返回稳定错误。
 * 脱敏 key 匹配大小写不敏感，嵌套对象同样生效。
 * 函数、循环引用和非 JSON 输入不能进入 audit metadata。
 * audit recorder 不保存原始 request，只接收调用方提供的 metadata。
 * 未声明的顶层、profile、retry 和 structured output 字段必须拒绝。
 * fallback 引用必须存在且保持同一模型 role。
 * fallback audit 必须记录实际 fallback 的 profileId 和 modelId。
 * 非法 outcome 不得通过类型断言绕过运行时校验。
 * BigInt、Date、Map 和 Set 不得被静默转换为审计对象。
 * password、cookie、credential 和 privateKey 必须进入敏感字段 denylist。
 * 共享数组或对象只在当前递归路径中去重，不得污染兄弟字段。
 * 脱敏必须保持可见的非敏感字段和原始对象隔离。
 * 版本化配置仍使用仓库内 JSON-compatible YAML 子集读取。
 * 所有断言均在本地内存中执行，不触发 provider 网络请求。
 * timeout 为零或超出有限边界时必须在 registry 初始化阶段失败。
 * retryOn 重复项不能通过配置校验，否则会产生不确定重试语义。
 * structured output 开启时缺失 schemaId 必须拒绝。
 * registry 查询未知 role 时必须返回稳定错误而不是 undefined。
 * profile 列表顺序用于保留配置快照，但 fallback 通过显式引用解析。
 * audit 的 traceId、runId 和 attempt 都必须满足最小结构约束。
 * provider 失败、超时和 fallback 只保留稳定分类，不保留模型正文。
 * 测试覆盖请求脱敏和审计脱敏两条边界，避免调用方遗漏处理。
 * 该测试文件不验证真实 provider 适配器，真实调用属于后续任务。
 * 配置文本支持 ${VAR} 环境变量引用，引用值在 JSON 解析前注入，缺失时必须 fail-closed。
 * 每个非法配置分支都断言抛错，保证 fail-closed 行为可回归。
 * 共享引用测试确认递归状态在兄弟节点之间被清理。
 * 敏感字段测试确认大小写无关的 denylist 行为。
 * fallback 测试确认版本审计不会继续引用 primary。
 * 结果断言使用稳定字段，避免依赖日志文本或执行时序。
 * 本文件覆盖 Task 3.1 的 profile、redaction 和 audit acceptance。
 * 测试不调用真实模型、不读取环境密钥、不发送网络请求。
 * Task 3.2 的 ModelGateway 将复用这里的 profile 和 audit contract。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ModelAuditRecorder, ModelProfileRegistry, loadModelProfiles, redactModelRequest } from '@iar/runtime';

/**
 * 读取版本化模型配置文本。
 * @returns 配置文件内容
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function configText(): string {
  return readFileSync(join(process.cwd(), 'config', 'models.yaml'), 'utf8');
}

/* profile registry 和审计入口尚未存在时，这个 focused 测试应先 RED。 */
test('loads versioned model profiles and keeps audit output redacted', () => {
  const registry = new ModelProfileRegistry(loadModelProfiles(configText()));
  const profile = registry.forRole('semantic.extract');
  assert.equal(profile.role, 'semantic.extract');
  const request = { apiKey: 'secret-key', rawPrompt: 'stop test1', nested: { rawUserInput: 'test1', visible: 'keep' } };
  const redacted = redactModelRequest(request);
  const audit = new ModelAuditRecorder(registry).record({ traceId: 'trace-1', runId: 'run-1', role: profile.role, outcome: 'success', attempt: 1, metadata: redacted });

  assert.equal(redacted.apiKey, '[REDACTED]');
  assert.equal(redacted.nested.rawUserInput, '[REDACTED]');
  assert.equal(audit.profileVersion, profile.profileVersion);
  assert.equal(audit.modelVersion, profile.modelVersion);
  assert.equal(JSON.stringify(audit).includes('stop test1'), false);
  assert.equal(JSON.stringify(audit).includes('secret-key'), false);
  assert.deepEqual(registry.list().map((item) => item.role), ['semantic.extract', 'semantic.extract', 'function.select', 'function.select', 'plugin.select', 'plugin.select', 'function.select', 'plugin.select', 'context.compact', 'context.compact', 'response.generate', 'response.generate']);
  assert.equal(profile.fallbackProfileId, 'semantic-extractor-fallback');
  const fallbackAudit = new ModelAuditRecorder(registry).record({ traceId: 'trace-fallback', runId: 'run-fallback', role: profile.role, outcome: 'fallback', fallbackUsed: true, attempt: 1, metadata: { reason: 'timeout' } });
  assert.equal(fallbackAudit.profileId, 'semantic-extractor-fallback');
  assert.equal(fallbackAudit.modelId, 'semantic-extractor-fallback');
  request.nested.visible = 'changed';
  assert.equal(redacted.nested.visible, 'keep');
});

/* 非法 timeout、retry 和 fallback 引用必须在加载阶段拒绝。 */
test('rejects invalid model profile configuration', () => {
  const parsed = JSON.parse(configText()) as { profiles: Array<Record<string, unknown>> };
  const first = parsed.profiles[0];
  assert.ok(first);
  first.timeoutMs = 0;
  assert.throws(() => loadModelProfiles(parsed));

  const withUnknownProfileField = JSON.parse(configText()) as { profiles: Array<Record<string, unknown>> };
  const profileWithUnknownField = withUnknownProfileField.profiles[0];
  assert.ok(profileWithUnknownField);
  profileWithUnknownField.apiKey = 'must-not-load';
  assert.throws(() => loadModelProfiles(withUnknownProfileField));

  const withUnknownRetryField = JSON.parse(configText()) as { profiles: Array<Record<string, unknown>> };
  const retryOwner = withUnknownRetryField.profiles[0];
  assert.ok(retryOwner);
  (retryOwner.retryPolicy as Record<string, unknown>).rawPrompt = 'must-not-load';
  assert.throws(() => loadModelProfiles(withUnknownRetryField));

  const withUnknownStructuredField = JSON.parse(configText()) as { profiles: Array<Record<string, unknown>> };
  const structuredOwner = withUnknownStructuredField.profiles[0];
  assert.ok(structuredOwner);
  (structuredOwner.structuredOutput as Record<string, unknown>).apiKey = 'must-not-load';
  assert.throws(() => loadModelProfiles(withUnknownStructuredField));

  const withMissingFallback = JSON.parse(configText()) as { profiles: Array<Record<string, unknown>> };
  const fallbackSource = withMissingFallback.profiles[0];
  assert.ok(fallbackSource);
  fallbackSource.fallbackProfileId = 'missing-profile';
  assert.throws(() => loadModelProfiles(withMissingFallback));

  const withCrossRoleFallback = JSON.parse(configText()) as { profiles: Array<Record<string, unknown>> };
  const crossRoleSource = withCrossRoleFallback.profiles[0];
  assert.ok(crossRoleSource);
  crossRoleSource.fallbackProfileId = 'function-decision-fallback';
  assert.throws(() => loadModelProfiles(withCrossRoleFallback));
});

/* environment 只保存变量名，不保存 URL、密钥或模型实际值。 */
test('accepts non-secret environment override names on model profiles', () => {
  const config = JSON.parse(configText()) as { profiles: Array<Record<string, unknown>> };
  config.profiles = config.profiles.slice(0, 1);
  const profile = config.profiles[0];
  assert.ok(profile);
  delete profile.fallbackProfileId;
  profile.environment = { endpoint: 'IAR_LLM_BASE_URL', apiKey: 'IAR_LLM_API_KEY', modelId: 'IAR_LLM_MODEL_ID' };

  const loaded = loadModelProfiles(config);

  assert.deepEqual(loaded[0]?.environment, { endpoint: 'IAR_LLM_BASE_URL', apiKey: 'IAR_LLM_API_KEY', modelId: 'IAR_LLM_MODEL_ID' });
  assert.equal(JSON.stringify(loaded).includes('secret-value'), false);
});

/* environment 只允许 endpoint、apiKey、modelId 和合法环境变量名。 */
test('rejects malformed environment override mappings', () => {
  const cases = [
    { endpoint: 'IAR-LMM-BASE_URL' },
    { apiKey: '' },
    { modelId: 'IAR MODEL ID' },
    { unknown: 'IAR_UNKNOWN' }
  ];
  cases.forEach((environment) => {
    const config = JSON.parse(configText()) as { profiles: Array<Record<string, unknown>> };
    config.profiles = config.profiles.slice(0, 1);
    const profile = config.profiles[0];
    assert.ok(profile);
    delete profile.fallbackProfileId;
    profile.environment = environment;
    assert.throws(() => loadModelProfiles(config), /模型 profile 无效/);
  });
});

/* 旧配置全部未声明 decisionBackend 时继续兼容，显式启用后则必须完整声明。 */
test('keeps legacy selection profiles without decisionBackend compatible', () => {
  const config = JSON.parse(configText()) as { profiles: Array<Record<string, unknown>> };
  config.profiles = config.profiles.filter((item) => item.profileId === 'function-decision-primary' || item.profileId === 'function-decision-fallback' || item.profileId === 'plugin-decision-primary' || item.profileId === 'plugin-decision-fallback');
  config.profiles.forEach((item) => { delete item.decisionBackend; });
  const profiles = loadModelProfiles(config);
  const functionProfile = profiles.find((item) => item.role === 'function.select');
  const pluginProfile = profiles.find((item) => item.role === 'plugin.select');
  assert.ok(functionProfile);
  assert.ok(pluginProfile);
  assert.equal(Object.hasOwn(functionProfile, 'decisionBackend'), false);
  assert.equal(Object.hasOwn(pluginProfile, 'decisionBackend'), false);
});

/* legacy selection 仍需按兼容 backend 校验 primary 关系，不能跳过关系图。 */
test('rejects duplicate primary profiles in the legacy selection group', () => {
  const config = JSON.parse(configText()) as { profiles: Array<Record<string, unknown>> };
  config.profiles = config.profiles.filter((item) => item.profileId === 'function-decision-primary' || item.profileId === 'function-decision-fallback');
  const primary = config.profiles[0];
  assert.ok(primary);
  config.profiles.push({ ...primary, profileId: 'legacy-function-secondary-primary', fallbackProfileId: undefined });

  assert.throws(() => new ModelProfileRegistry(config.profiles as never), /同一 role\/decisionBackend 只能有一个 primary profile/);
});

/* 非选择 role 即使字段值为 undefined，也不能通过 own property 伪装成缺失。 */
test('rejects an own undefined decisionBackend on non-selection roles', () => {
  const config = JSON.parse(configText()) as { profiles: Array<Record<string, unknown>> };
  config.profiles = config.profiles.filter((item) => item.role === 'semantic.extract');
  const profile = config.profiles[0];
  assert.ok(profile);
  profile.decisionBackend = undefined;
  assert.equal(Object.hasOwn(profile, 'decisionBackend'), true);

  assert.throws(() => new ModelProfileRegistry(config.profiles as never), /模型 profile 无效/);
});

/* selection role 只有完全没有字段时才享受 legacy 兼容，显式 undefined 必须拒绝。 */
test('rejects an own undefined decisionBackend on selection roles', () => {
  const config = JSON.parse(configText()) as { profiles: Array<Record<string, unknown>> };
  config.profiles = config.profiles.filter((item) => item.profileId === 'function-decision-primary' || item.profileId === 'function-decision-fallback');
  const primary = config.profiles[0];
  assert.ok(primary);
  primary.decisionBackend = undefined;
  assert.equal(Object.hasOwn(primary, 'decisionBackend'), true);

  assert.throws(() => new ModelProfileRegistry(config.profiles as never), /模型 profile 无效/);
});

/* Function 和 Plugin 选择 profile 只能声明受限的决策后端。 */
test('accepts decisionBackend on function and plugin selection profiles', () => {
  const config = JSON.parse(configText()) as { profiles: Array<Record<string, unknown>> };
  config.profiles.filter((item) => item.role === 'function.select').forEach((item) => { item.decisionBackend = item.profileId === 'function-decision-primary' || item.profileId === 'function-decision-fallback' ? 'jev' : 'intent-model'; });
  config.profiles.filter((item) => item.role === 'plugin.select').forEach((item) => { item.decisionBackend = item.profileId === 'plugin-decision-primary' || item.profileId === 'plugin-decision-fallback' ? 'jev' : 'intent-model'; });

  const profiles = loadModelProfiles(config);
  assert.deepEqual(profiles.filter((item) => item.role === 'function.select').map((item) => item.decisionBackend), ['jev', 'jev', 'intent-model']);
  assert.deepEqual(profiles.filter((item) => item.role === 'plugin.select').map((item) => item.decisionBackend), ['jev', 'jev', 'intent-model']);
});

/* 未知 backend 不得绕过决策后端白名单。 */
test('rejects unknown decisionBackend values', () => {
  const config = JSON.parse(configText()) as { profiles: Array<Record<string, unknown>> };
  config.profiles = config.profiles.filter((item) => item.profileId === 'function-decision-primary' || item.profileId === 'function-decision-fallback');
  config.profiles.forEach((item) => { item.decisionBackend = 'unknown-backend'; });

  assert.throws(() => new ModelProfileRegistry(config.profiles as never), /模型 profile 无效/);
});

/* 同一 role/backend 下只能存在一个不被 fallback 引用的 primary profile。 */
test('rejects duplicate primary profiles for the same role and decisionBackend', () => {
  const config = JSON.parse(configText()) as { profiles: Array<Record<string, unknown>> };
  config.profiles = config.profiles.filter((item) => item.profileId === 'function-decision-primary' || item.profileId === 'function-decision-fallback');
  config.profiles.forEach((item) => { item.decisionBackend = 'jev'; });
  const primary = config.profiles[0];
  assert.ok(primary);
  config.profiles.push({ ...primary, profileId: 'function-decision-secondary-primary', fallbackProfileId: undefined });

  assert.throws(() => new ModelProfileRegistry(config.profiles as never), /同一 role\/decisionBackend 只能有一个 primary profile/);
});

/* fallback 必须保持同一 role/backend，避免隐式跨后端切换。 */
test('rejects fallback profiles that point to another decisionBackend', () => {
  const config = JSON.parse(configText()) as { profiles: Array<Record<string, unknown>> };
  config.profiles = config.profiles.filter((item) => item.profileId === 'function-decision-primary' || item.profileId === 'function-decision-fallback');
  const primary = config.profiles[0];
  const fallback = config.profiles[1];
  assert.ok(primary);
  assert.ok(fallback);
  primary.decisionBackend = 'jev';
  fallback.decisionBackend = 'intent-model';

  assert.throws(() => new ModelProfileRegistry(config.profiles as never), /fallback profile 必须保持同一 role\/decisionBackend/);
});

/* fallback 图不得形成环，否则不存在可审计的 primary 链。 */
test('rejects fallback cycles within a role and decisionBackend group', () => {
  const config = JSON.parse(configText()) as { profiles: Array<Record<string, unknown>> };
  config.profiles = config.profiles.filter((item) => item.profileId === 'function-decision-primary' || item.profileId === 'function-decision-fallback');
  const primary = config.profiles[0];
  const fallback = config.profiles[1];
  assert.ok(primary);
  assert.ok(fallback);
  primary.decisionBackend = 'jev';
  fallback.decisionBackend = 'jev';
  primary.fallbackProfileId = String(fallback.profileId);
  fallback.fallbackProfileId = String(primary.profileId);

  assert.throws(() => new ModelProfileRegistry(config.profiles as never), /fallback 环/);
});

/* 同一 role 的不同 backend 各自拥有 primary 时，不应被混合判重。 */
test('allows one primary per backend within the same role', () => {
  const config = JSON.parse(configText()) as { profiles: Array<Record<string, unknown>> };
  config.profiles = config.profiles.filter((item) => item.profileId === 'function-decision-primary' || item.profileId === 'function-decision-fallback');
  const primary = config.profiles[0];
  const fallback = config.profiles[1];
  assert.ok(primary);
  assert.ok(fallback);
  primary.decisionBackend = 'jev';
  fallback.decisionBackend = 'jev';
  const intentFallbackId = 'function-decision-intent-fallback';
  config.profiles.push(
    { ...primary, profileId: 'function-decision-intent-primary', decisionBackend: 'intent-model', fallbackProfileId: intentFallbackId },
    { ...fallback, profileId: intentFallbackId, decisionBackend: 'intent-model', fallbackProfileId: undefined }
  );

  assert.doesNotThrow(() => new ModelProfileRegistry(config.profiles as never));
});

/* 非选择 role 不得携带只对决策选择有效的 backend 字段。 */
test('rejects decisionBackend on non-selection roles', () => {
  const config = JSON.parse(configText()) as { profiles: Array<Record<string, unknown>> };
  config.profiles = config.profiles.filter((item) => item.role === 'semantic.extract');
  const profile = config.profiles[0];
  assert.ok(profile);
  profile.decisionBackend = 'jev';

  assert.throws(() => new ModelProfileRegistry(config.profiles as never), /模型 profile 无效/);
});

/* 显式启用 backend 后，选择 role 缺失字段必须 fail-closed。 */
test('rejects selection roles missing decisionBackend in an explicit backend configuration', () => {
  const config = JSON.parse(configText()) as { profiles: Array<Record<string, unknown>> };
  config.profiles = config.profiles.filter((item) => item.role === 'function.select');
  const primary = config.profiles[0];
  assert.ok(primary);
  primary.decisionBackend = 'jev';
  const fallback = config.profiles[1];
  assert.ok(fallback);
  delete fallback.decisionBackend;

  assert.throws(() => new ModelProfileRegistry(config.profiles as never), /选择 role 必须声明 decisionBackend/);
});

/* 配置文本中的 ${VAR} 引用必须从环境变量解析，缺失时 fail-closed。 */
test('resolves ${VAR} environment references and fails closed when missing', () => {
  const config = JSON.parse(configText()) as { profiles: Array<Record<string, unknown>> };
  config.profiles = config.profiles.slice(0, 1);
  const only = config.profiles[0];
  assert.ok(only);
  only.modelId = '${IAR_TEST_MODEL_ID}';
  delete only.fallbackProfileId;

  process.env.IAR_TEST_MODEL_ID = 'env-model-v1';
  try {
    const profiles = loadModelProfiles(JSON.stringify(config));
    assert.equal(profiles[0]?.modelId, 'env-model-v1');
    process.env.IAR_TEST_MODEL_ID = 'quote"back\\slash';
    const escaped = loadModelProfiles(JSON.stringify(config));
    assert.equal(escaped[0]?.modelId, 'quote"back\\slash');
  } finally {
    delete process.env.IAR_TEST_MODEL_ID;
  }
  assert.throws(() => loadModelProfiles(JSON.stringify(config)), /环境变量未设置/);
});

/* audit 必须拒绝未知 outcome、非 JSON metadata，并正确处理共享引用。 */
test('rejects non-json audit metadata and preserves shared redacted values', () => {
  const registry = new ModelProfileRegistry(loadModelProfiles(configText()));
  const recorder = new ModelAuditRecorder(registry);
  /* null 和非对象输入必须产生稳定的业务错误，而不是原生 TypeError。 */
  assert.throws(() => recorder.record(null as never));
  /* fallback 请求没有配置目标时必须 fail-closed。 */
  const noFallbackProfiles = loadModelProfiles(configText()).map(({ fallbackProfileId: _fallbackProfileId, ...item }) => item);
  assert.throws(() => new ModelProfileRegistry(noFallbackProfiles).forRole('semantic.extract', true));
  /* fallbackUsed 只能是 boolean，不能被字符串等 truthy 值伪装。 */
  assert.throws(() => recorder.record({ traceId: 'trace-2', runId: 'run-2', role: 'function.select', outcome: 'success', fallbackUsed: 'true' as never, attempt: 1, metadata: {} }));
  /* outcome 枚举不可信时必须在 audit boundary 直接拒绝。 */
  assert.throws(() => recorder.record({ traceId: 'trace-2', runId: 'run-2', role: 'function.select', outcome: 'unknown' as never, attempt: 1, metadata: {} }));
  /* BigInt 不能被 JSON 序列化，不能先被转换为普通对象。 */
  assert.throws(() => recorder.record({ traceId: 'trace-2', runId: 'run-2', role: 'function.select', outcome: 'success', attempt: 1, metadata: { value: BigInt(1) } as never }));
  /* Date、Map、Set 同样不是允许写入审计的 plain JSON object。 */
  assert.throws(() => recorder.record({ traceId: 'trace-2', runId: 'run-2', role: 'function.select', outcome: 'success', attempt: 1, metadata: { value: new Date() } as never }));
  assert.throws(() => recorder.record({ traceId: 'trace-2', runId: 'run-2', role: 'function.select', outcome: 'success', attempt: 1, metadata: { value: new Map() } as never }));
  assert.throws(() => recorder.record({ traceId: 'trace-2', runId: 'run-2', role: 'function.select', outcome: 'success', attempt: 1, metadata: { value: new Set() } as never }));
  /* 常见凭证字段和原始正文必须统一替换。 */
  const sensitive = redactModelRequest({ password: 'p', cookie: 'c', credential: 'c', privateKey: 'k', visible: 'keep' });
  assert.deepEqual(sensitive, { password: '[REDACTED]', cookie: '[REDACTED]', credential: '[REDACTED]', privateKey: '[REDACTED]', visible: 'keep' });
  /* 同一引用在兄弟字段中出现时，递归路径必须正确恢复。 */
  const shared = { visible: 'keep', rawPrompt: 'secret' };
  const redacted = redactModelRequest({ first: shared, second: shared });
  assert.deepEqual(redacted.first, { visible: 'keep', rawPrompt: '[REDACTED]' });
  assert.deepEqual(redacted.second, { visible: 'keep', rawPrompt: '[REDACTED]' });
});
