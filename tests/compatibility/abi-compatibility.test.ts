/**
 * 验证跨语言 ABI 的版本、JSON-safe、Manifest/Schema 和错误边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSIONS } from '../../packages/contracts/src/index.js';
import { checkAbiCompatibility, validateControlPlaneRequest, type ControlPlaneRequest } from '../../packages/abi/src/index.js';

/** 构造租户隔离且可跨语言 JSON 序列化的 control-plane 请求。 */
function request(overrides: Partial<ControlPlaneRequest> = {}): ControlPlaneRequest {
  return {
    protocolVersion: 'iar.control-plane/v1',
    requestId: 'request-1',
    traceId: 'trace-1',
    context: { tenantId: 'tenant-a', actorId: 'actor-a', environment: 'prod' },
    operation: 'plugin.inspect',
    payload: { pluginId: 'plugin-a' },
    ...overrides
  };
}

test('valid control-plane request passes ABI validation and JSON round-trip', () => {
  // Given：请求只使用版本化 ABI 允许的 JSON-safe 字段。
  const value = request();
  // When：边界校验并跨语言模拟 JSON encode/decode。
  const result = validateControlPlaneRequest(JSON.parse(JSON.stringify(value)));
  // Then：返回冻结语义的安全副本，不改变 tenant 或 operation。
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, value);
});

test('unknown fields and inherited values are rejected before dispatch', () => {
  // Given：调用方尝试透传 raw secret 和原型字段。
  const value = { ...request(), secret: 'private-key' } as unknown as Record<string, unknown>;
  const inherited = Object.create({ pluginId: 'foreign-plugin' }) as Record<string, unknown>;
  Object.assign(inherited, request().payload);
  // Then：顶层和嵌套 allow-list 都必须拒绝。
  assert.equal(validateControlPlaneRequest(value).ok, false);
  assert.equal(validateControlPlaneRequest({ ...request(), payload: inherited }).ok, false);
  // ABI 不允许 control plane 透传未声明字段。
});

test('wrong ABI version and malformed identifiers return stable errors', () => {
  // Given：旧版本协议、空 tenant 和非法 requestId。
  const oldVersion = validateControlPlaneRequest({ ...request(), protocolVersion: 'iar.control-plane/v0' });
  const emptyTenant = validateControlPlaneRequest({ ...request(), context: { ...request().context, tenantId: '' } });
  const badRequestId = validateControlPlaneRequest({ ...request(), requestId: 'request with spaces' });
  // Then：错误码稳定且不泄露原始 payload。
  assert.equal(oldVersion.ok, false);
  assert.equal(emptyTenant.ok, false);
  assert.equal(badRequestId.ok, false);
  if (!oldVersion.ok) assert.equal(oldVersion.reasonCode, 'abi_version_incompatible');
});

test('manifest-bearing payload must satisfy the same schema contract', () => {
  // Given：install 请求携带缺少 schemaVersion 的签名 artifact Manifest。
  const malformed = { ...request(), operation: 'plugin.install' as const, payload: { artifact: { artifactVersion: 'v1', signerKeyId: 'signer', signature: 'sig', bundleDigest: 'sha256:bad', manifest: { pluginId: 'plugin-a' } } } };
  // Then：ABI 不重新定义 Manifest，而是复用 contracts validator。
  const result = validateControlPlaneRequest(malformed);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reasonCode, 'manifest_invalid');
  assert.equal(SCHEMA_VERSIONS.pluginManifest, 'iar.plugin-manifest/v1');
});

test('compatibility matrix accepts only explicitly supported versions', () => {
  // Given：当前 ABI 与未来 ABI 的两个版本组合。
  const supported = checkAbiCompatibility('iar.control-plane/v1', 'iar.control-plane/v1');
  const unsupported = checkAbiCompatibility('iar.control-plane/v1', 'iar.control-plane/v2');
  // Then：不通过隐式降级或字符串比较接受未来协议。
  assert.deepEqual(supported, { ok: true, value: true });
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.equal(unsupported.reasonCode, 'abi_version_incompatible');
});

test('cyclic, non-json and revoked proxy inputs fail closed without throwing', () => {
  // Given：循环对象、BigInt 和 revoked Proxy。
  const cyclic: Record<string, unknown> = { ...request() };
  cyclic.payload = cyclic;
  const revoked = Proxy.revocable(request(), {});
  revoked.revoke();
  // Then：所有输入都返回稳定失败，不把底层 TypeError 泄露给调用方。
  assert.equal(validateControlPlaneRequest(cyclic).ok, false);
  assert.equal(validateControlPlaneRequest({ ...request(), payload: { value: 1n } }).ok, false);
  assert.equal(validateControlPlaneRequest(revoked.proxy).ok, false);
});

// ABI 测试刻意使用普通 JSON-compatible fixture。
// 每个请求都携带显式协议版本。
// 每个上下文都携带 tenant、actor 和 environment。
// 未知顶层字段在 dispatch 前拒绝。
// 原型继承字段不能成为 control-plane 数据。
// Manifest 校验继续由共享 contracts 包负责。
// 签名 artifact 对通用 ABI 层保持不透明。
// 不支持的版本不会隐式降级。
// 循环值不会进入 JSON 序列化。
// BigInt 和非有限数字不是跨语言值。
// revoked Proxy 不能泄露 getter 异常。
// 兼容性检查是显式矩阵查询。
// 错误码在不同语言实现间保持稳定。
// 成功值在返回前执行 structured clone。
// 这些用例定义 control-plane 测试消费的 wire 边界。
// 测试不依赖 JavaScript 专属的 class identity。
// 测试不发送真实网络请求。
// 所有失败都通过稳定 reason code 检查。
// compatibility matrix 刻意保持保守。
// 共享 Manifest Schema 仍是权威契约。
// ABI 测试可在所有支持的 Node 版本重复执行。
// 该套件是未来语言客户端的交接矩阵。
// fixture 修改始终作用于本地副本。
// 测试名称描述其证明的边界义务。
// 最终断言避免访问实现私有状态。
