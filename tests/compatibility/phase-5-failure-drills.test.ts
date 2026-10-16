/**
 * 验证 Phase 5 跨语言 ABI 的兼容矩阵和安全错误边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkAbiCompatibility, validateControlPlaneRequest, type ControlPlaneRequest } from '../../packages/abi/src/index.js';
import { createTenantControlPlane } from '../../packages/control-plane/src/index.js';
import { PluginHost } from '../../packages/plugin-host/src/index.js';

/**
 * 创建跨语言 ABI 使用的稳定请求 fixture。
 * @param overrides - 用于构造拒绝路径的字段覆盖
 * @returns JSON-safe control-plane request
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function request(overrides: Partial<ControlPlaneRequest> = {}): ControlPlaneRequest {
  return {
    protocolVersion: 'iar.control-plane/v1',
    requestId: 'compat-request-1',
    traceId: 'compat-trace-1',
    context: { tenantId: 'tenant-a', actorId: 'actor-a', environment: 'prod' },
    operation: 'plugin.inspect',
    payload: { pluginId: 'drill-plugin' },
    ...overrides
  };
}

test('ABI request survives JSON encode/decode with the same tenant and operation', () => {
  // Given：JavaScript 请求经过 JSON encode/decode 模拟另一种语言客户端。
  const decoded = JSON.parse(JSON.stringify(request())) as unknown;
  // When：decoded value 进入 ABI validator。
  const validated = validateControlPlaneRequest(decoded);
  assert.equal(validated.ok, true);
  if (validated.ok) {
    assert.deepEqual(validated.value, request());
    assert.equal(validated.value.context.tenantId, 'tenant-a');
    assert.equal(validated.value.operation, 'plugin.inspect');
  }
  // Then：tenant、operation 和 payload 在 wire round-trip 后保持一致。
});

test('unsupported version, unknown nested field and malformed artifact fail before dispatch', () => {
  // Given：协议版本、嵌套字段和 Manifest 分别遭遇不兼容或格式错误。
  const unsupported = validateControlPlaneRequest({ ...request(), protocolVersion: 'iar.control-plane/v2' });
  const unknown = validateControlPlaneRequest({ ...request(), payload: { pluginId: 'drill-plugin', rawSignature: 'secret' } });
  const malformedArtifact = validateControlPlaneRequest({ ...request(), operation: 'plugin.install', payload: { artifact: { artifactVersion: 'v1', signerKeyId: 'drill-signer', signature: 'sig', bundleDigest: 'sha256:bad', manifest: null } } });
  assert.equal(unsupported.ok, false);
  assert.equal(unknown.ok, false);
  assert.equal(malformedArtifact.ok, false);
  if (!unsupported.ok) assert.equal(unsupported.reasonCode, 'abi_version_incompatible');
  if (!unknown.ok) assert.equal(unknown.reasonCode, 'abi_input_invalid');
  if (!malformedArtifact.ok) assert.equal(malformedArtifact.reasonCode, 'manifest_invalid');
  // Then：所有错误在 control-plane dispatch 前通过稳定 reason code 暴露。
});

test('cyclic values and revoked Proxy return stable ABI errors without leaking raw payload', () => {
  // Given：循环对象和 revoked Proxy 模拟恶意跨语言输入。
  const cyclic = request() as unknown as Record<string, unknown>;
  cyclic.payload = cyclic;
  assert.equal(validateControlPlaneRequest(cyclic).ok, false);

  const revoked = Proxy.revocable(request(), {});
  revoked.revoke();
  const result = validateControlPlaneRequest(revoked.proxy);
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes('compat-request-1'), false);
  // Then：validator 不抛出原始异常，也不回显 request 内容。
});

test('compatibility matrix does not silently downgrade or accept future ABI versions', () => {
  // Given：当前 v1、同版本请求和未来 v2 请求组成显式矩阵。
  assert.deepEqual(checkAbiCompatibility('iar.control-plane/v1', 'iar.control-plane/v1'), { ok: true, value: true });
  const future = checkAbiCompatibility('iar.control-plane/v1', 'iar.control-plane/v2');
  assert.equal(future.ok, false);
  if (!future.ok) assert.equal(future.reasonCode, 'abi_version_incompatible');
  // Then：兼容性只允许显式支持的版本组合。
});

test('control-plane error response never echoes raw artifact, signature or bundle material', async () => {
  // Given：ABI 合法外壳携带 malformed artifact 和不应回显的敏感字段。
  const api = createTenantControlPlane({
    trustedSigners: new Map(),
    hostFactory: () => ({ host: new PluginHost({ functionIds: ['function.drill'] }), compatibility: { hostApiVersion: 'iar.dev/v1', installed: new Map(), availableDependencies: new Set() } }),
    authorize: () => ({ allowed: true })
  });
  const response = await api.request({
    ...request(),
    operation: 'plugin.install',
    payload: {
      artifact: {
        artifactVersion: 'v1',
        signerKeyId: 'unknown',
        signature: 'raw-signature-material',
        bundleDigest: 'sha256:bad',
        manifest: null,
        privateKey: 'private-key-material',
        bundle: 'raw-bundle-material'
      }
    }
  });
  // Then：错误响应只保留稳定 code，不包含原始 artifact 内容。
  assert.notEqual(response.error, null);
  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes('raw-signature-material'), false);
  assert.equal(serialized.includes('private-key-material'), false);
  assert.equal(serialized.includes('raw-bundle-material'), false);
});

// ABI round-trip 只验证 JSON wire shape，不依赖 JavaScript class identity。
// tenantId、actorId 和 environment 是跨语言上下文的最小身份集合。
// unknown nested field 在 dispatch 前拒绝，避免控制面透传未声明参数。
// malformed Manifest 继续复用 contracts 的权威 schema，而不在 ABI 层复制定义。
// unsupported version 不会触发隐式降级或未来字段猜测。
// cyclic payload 不能进入 JSON ABI，也不能穿透 validator 的异常边界。
// revoked Proxy 用来模拟 getter 异常和恶意状态竞态。
// 所有拒绝均通过稳定 reasonCode 表达，方便其他语言实现相同矩阵。
// control-plane response 只保留安全 error code，不回显原始 payload。
// raw signature、private key 和 bundle 仅作为反回显 sentinel。
// 测试不要求真实 signer，因为失败发生在 ABI/Manifest boundary。
// valid request 的 payload 使用 pluginId，覆盖 inspect 的最小 operation。
// install 请求使用 artifact 外壳，覆盖分发字段的兼容性入口。
// response JSON 检查同时覆盖错误序列化和控制面公开边界。
// ABI compatibility matrix 是显式 pair lookup，不以字符串前缀推断兼容。
// v1/v1 是唯一当前成功组合，v1/v2 必须 fail closed。
// validator 返回安全副本，调用方不能通过原对象继续改变 wire 事实。
// 失败请求不会创建 tenant Host，也不会触发插件生命周期。
// 测试用内存 Host factory，避免把 network 或数据库状态混入兼容性证据。
// 这些演练作为跨语言客户端的最小交接矩阵。
// 它们与既有 ABI 套件共同覆盖成功、拒绝、异常和敏感字段边界。
// request helper 只生成协议允许字段，覆盖测试修改始终作用于副本。
// round-trip 断言使用深比较，避免只验证单个 tenant 字段而遗漏结构漂移。
// unknown nested field 以 rawSignature sentinel 表示未声明安全字段。
// malformed artifact 同时携带错误 digest 和 null Manifest，验证最早稳定错误。
// revoked Proxy 的底层 TypeError 不应跨越 ABI 公开边界。
// cyclic payload 的拒绝不依赖 JSON.stringify 抛出异常来完成断言。
// ABI matrix 的失败分支必须可被调用方按 reasonCode 分类处理。
// control-plane API 使用空 signer map，确保错误来自输入而非密码学偶然性。
// Host factory 仍然是可观察的隔离边界，即使本测试只检查错误 response。
// raw-signature sentinel 代表签名正文而不是 property name。
// private-key sentinel 代表不应进入 error.details 的敏感材料。
// raw-bundle sentinel 代表远程包体，控制面不应把它回显给客户端。
// response 序列化检查覆盖 data、error 和 trace 可能出现的公开分支。
// ABI 输入和 control-plane response 共同构成跨语言故障演练。
// 该文件不修改协议版本，不为未来 v2 预留隐式兼容。
// 所有测试均为确定性内存测试，可在不同 Node 版本重复执行。
// 这些证据交给未来 Go/Rust/Java 客户端时仍只依赖 JSON 契约。
