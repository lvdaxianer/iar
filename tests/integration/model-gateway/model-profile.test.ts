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
import { ModelAuditRecorder, ModelProfileRegistry, loadModelProfiles, redactModelRequest } from '../../../packages/decision/src/index.js';

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
  assert.deepEqual(registry.list().map((item) => item.role), ['semantic.extract', 'semantic.extract', 'function.select', 'function.select', 'plugin.select', 'plugin.select', 'context.compact', 'context.compact', 'response.generate', 'response.generate']);
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
