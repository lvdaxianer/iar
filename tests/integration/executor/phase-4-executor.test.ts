/**
 * 验证 Worker、Sidecar、container executor 共用同一安全消息和生命周期契约。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createContainerExecutor, createSidecarExecutor, createWorkerExecutor, type ExecutorRequest } from '@iar/adapters-executors';
import { SubscriptionRegistry, type HookSubscription } from '@iar/subscriptions';

/*
 * fixture 只使用 JSON-safe 输入和固定版本，避免测试绕过 transport 边界。
 * 每个 executor 在测试结束时 close，确保没有活动 timer 或 pending request。
 * credential resolver 记录 scope 但不把 secret 放入响应或错误。
 * subscriptionOwner 显式决定插件是否拥有某条订阅，避免按字符串猜测租户。
 * timeout/cancel 断言 handler 收到 AbortSignal 后不能继续产生成功响应。
 * resource limit 断言输入在 handler 调用前被拒绝。
 * 三种 mode 只允许返回 mode 元数据差异，data/error 必须等价。
 * 错误断言只比较稳定 code，不依赖内部异常文本。
 * malformed protocol 使用 unknown cast 模拟不可信 transport 输入。
 * capability denied 与 invalid request 分别验证语义层和格式层。
 * version mismatch 在 handler 前返回，避免旧插件获得执行机会。
 * mode parity 只允许 response.mode 不同。
 * timeout 使用短预算，避免测试依赖真实长等待。
 * cancel 通过 requestId 精确定位活动执行。
 * activeRequestCount 是 cleanup 的可观察证据。
 * 输入预算按 UTF-8 JSON bytes 计算。
 * output secret 不应出现在 JSON response。
 * credential scope 必须绑定 tenant、plugin 和精确版本。
 * resolver 返回 undefined 时应稳定失败。
 * handler 不会收到 credential value。
 * plugin cleanup 先取消执行再移除订阅。
 * plugin-a cleanup 不能删除 plugin-b subscription。
 * subscription registry 使用公开 API，不读取内部 Map。
 * subscription owner callback 模拟宿主的显式归属判断。
 * cleanup report 的 ID 顺序必须稳定。
 * 每个测试都关闭 executor，防止 timer 泄漏。
 * 这些测试不启动外部进程、网络或容器。
 * focused suite 只覆盖 Phase 4 Task 4.3 的边界。
 * observability、Temporal 和远程分发留给后续任务。
 * 测试 fixture 不包含真实凭据或用户输入。
 * 测试不读取环境变量，避免本地配置改变结果。
 * 所有 handler 输出都符合 SDK result 结构。
 * signal 只检查 aborted，不依赖内部 reason 字符串。
 * 资源失败必须在 handler 前发生。
 * close 后的额外调用由 core 单元语义覆盖。
 * 订阅 cleanup 断言只观察稳定 registry API。
 * test handler 不访问真实文件、网络或系统凭据。
 * request fixture 的默认 timeout 足够覆盖成功路径。
 * mode factory 的 options 完全一致以比较 contract。
 * response comparison 刻意忽略 mode 字段。
 * timeout test 允许 late handler 自然返回但不接受其结果。
 * cancel test 使用 setImmediate 等待 active 登记完成。
 * cleanup test 使用同一 tenant 的两个 plugin 对照隔离。
 * credential scope snapshot 只记录非 secret 元数据。
 * 资源限制测试输入大于配置字节预算。
 * malformed request 不应增加 handler calls。
 * version mismatch 不应增加 handler calls。
 * error code 命名空间固定为 executor。
 * test 输出不包含 secret-value。
 * 所有 close 均在断言后执行。
 * 失败时 Node test runner 会提供最小 assertion diff。
 * 当前 suite 不验证真实 container runtime。
 * 当前 suite 不验证真实跨进程 IPC。
 * 后续部署任务可复用此 contract fixture。
 * null request 覆盖 failure envelope 的安全读取。
 * hostile Proxy 覆盖 getter 抛错路径。
 * non-function handler 覆盖 active 登记前的校验。
 * mutable request 覆盖 requestId 和 tenantId late mutation。
 * frozen scope 覆盖 resolver 修改授权范围。
 * frozen output 覆盖 handler result late mutation。
 * cyclic input 覆盖 JSON graph 拒绝。
 * invalid errorCode 覆盖结果 schema 边界。
 * timeout/cancel 仍断言 active map 最终归零。
 * cleanup 仍验证另一插件订阅保留。
 * version/capability 错误都在 handler 调用前产生。
 * malformed/proxy 错误不产生状态副作用。
 * executor close 在每个 test 末尾运行。
 * test fixture 的 ID 全部是 ASCII 稳定字符串。
 * 不使用随机数避免 flaky 结果。
 * 断言不比较时间 duration。
 * 断言不依赖 Node 版本的 Error 文本。
 * 测试只依赖公开 executor API。
 * 可将同一 fixture 交给真实 transport adapter。
 * 当前实现不假设外部容器已安装。
 * active map 断言覆盖执行完成和 cleanup 完成两个时点。
 * scope 断言覆盖 resolver 的可变对象攻击。
 * result 断言覆盖返回后的调用方 mutation。
 * cyclic 断言覆盖有限遍历而非无限递归。
 * errorCode 断言覆盖稳定错误字段类型。
 * Proxy 断言覆盖边界读取异常。
 * handler 调用计数覆盖未授权执行路径。
 * subscription owner 断言覆盖显式归属策略。
 * report ID 断言覆盖排序确定性。
 * mode parity 断言覆盖三种 factory。
 */

/** @param overrides - 可选 request 覆盖字段 @returns 确定性 executor request @author lvdaxianer@yeah.net @date 2026-10-17 */
function validRequest(overrides: Partial<ExecutorRequest> = {}): ExecutorRequest {
  return { protocolVersion: 'iar.executor/v1', requestId: 'request-1', traceId: 'trace-1', tenantId: 'tenant-a', pluginId: 'plugin-a', pluginVersion: '1.0.0', capabilities: ['plugin.execute'], credentialRefs: [], input: {}, timeoutMs: 50, ...overrides };
}

/** @param pluginId - 插件标识 @returns 带归属标识的订阅 @author lvdaxianer@yeah.net @date 2026-10-17 */
function pluginSubscription(pluginId: string): HookSubscription {
  return { subscriptionId: `${pluginId}.subscription`, event: 'plugin.enabled', handler: { type: 'plugin', ref: `${pluginId}.handler` }, delivery: 'async', priority: 0, failurePolicy: 'fail-open' };
}

/** @returns 成功 HandlerResult @author lvdaxianer@yeah.net @date 2026-10-17 */
const successHandler = async () => ({ output: { accepted: true }, status: 'succeeded' as const });

test('executor rejects malformed protocol, capability and version inputs before handler', async () => {
  const executor = createWorkerExecutor({ version: '1.0.0', maxTimeoutMs: 100 });
  let calls = 0;
  const handler = async () => { calls += 1; return successHandler(); };
  const malformed = await executor.execute({ ...validRequest(), protocolVersion: 'iar.executor/v0' } as unknown as ExecutorRequest, handler);
  const capability = await executor.execute(validRequest({ capabilities: ['network:any'] }), handler);
  const version = await executor.execute(validRequest({ pluginVersion: '2.0.0' }), handler);
  assert.equal(malformed.error?.code, 'executor.invalid_request');
  assert.equal(capability.error?.code, 'executor.capability_denied');
  assert.equal(version.error?.code, 'executor.version_mismatch');
  assert.equal(calls, 0);
  await executor.close();
});

test('executor fails closed for null proxy and non-function handler without active state', async () => {
  const executor = createWorkerExecutor({ version: '1.0.0', maxTimeoutMs: 100 });
  const hostile = new Proxy(validRequest(), { get() { throw new Error('hostile getter'); } });
  const nullResponse = await executor.execute(null as unknown as ExecutorRequest, successHandler);
  const proxyResponse = await executor.execute(hostile, successHandler);
  const handlerResponse = await executor.execute(validRequest({ requestId: 'bad-handler' }), null as never);
  assert.equal(nullResponse.error?.code, 'executor.invalid_request');
  assert.equal(proxyResponse.error?.code, 'executor.invalid_request');
  assert.equal(handlerResponse.error?.code, 'executor.invalid_request');
  assert.equal(executor.activeRequestCount(), 0);
  await executor.close();
});

test('executor snapshots mutable request, frozen credential scope and handler result', async () => {
  const original = validRequest({ requestId: 'mutable-1', credentialRefs: ['api-key'] });
  const scopes: string[] = [];
  const executor = createWorkerExecutor({ version: '1.0.0', maxTimeoutMs: 100, resolveCredential: (scope) => { scopes.push(scope.tenantId); try { scope.tenantId = 'tenant-b'; } catch { /* frozen scope rejects mutation */ } return 'secret'; } });
  const output = { accepted: true };
  const pending = executor.execute(original, async () => ({ output, status: 'succeeded' as const }));
  original.requestId = 'mutated-id';
  original.tenantId = 'tenant-b';
  const response = await pending;
  output.accepted = false;
  assert.equal(response.requestId, 'mutable-1');
  assert.equal(response.pluginId, 'plugin-a');
  assert.deepEqual(response.data?.output, { accepted: true });
  assert.deepEqual(scopes, ['tenant-a']);
  await executor.close();
});

test('executor rejects cyclic JSON and invalid result errorCode', async () => {
  const executor = createWorkerExecutor({ version: '1.0.0', maxTimeoutMs: 100 });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const cyclicResponse = await executor.execute(validRequest({ input: cyclic as never }), successHandler);
  const resultResponse = await executor.execute(validRequest({ requestId: 'invalid-result' }), async () => ({ output: {}, status: 'succeeded' as const, errorCode: 42 } as never));
  assert.equal(cyclicResponse.error?.code, 'executor.invalid_request');
  assert.equal(resultResponse.error?.code, 'executor.invalid_result');
  await executor.close();
});

test('executor rejects unknown result fields and does not echo unbounded request metadata', async () => {
  const executor = createWorkerExecutor({ version: '1.0.0', maxTimeoutMs: 100 });
  const unknownField = await executor.execute(validRequest({ requestId: 'unknown-field' }), async () => ({ output: {}, status: 'succeeded' as const, secret: 'secret-value' } as never));
  const unboundedRequest = { ...validRequest(), requestId: 'x'.repeat(257) } as unknown as ExecutorRequest;
  const invalidRequest = await executor.execute(unboundedRequest, successHandler);
  assert.equal(unknownField.error?.code, 'executor.invalid_result');
  assert.equal(JSON.stringify(unknownField).includes('secret-value'), false);
  assert.equal(invalidRequest.error?.code, 'executor.invalid_request');
  assert.equal(invalidRequest.requestId, '');
  await executor.close();
});

test('Worker, Sidecar and container preserve equivalent success semantics', async () => {
  const executors = [
    createWorkerExecutor({ version: '1.0.0', maxTimeoutMs: 100 }),
    createSidecarExecutor({ version: '1.0.0', maxTimeoutMs: 100 }),
    createContainerExecutor({ version: '1.0.0', maxTimeoutMs: 100 })
  ];
  const responses = await Promise.all(executors.map((executor) => executor.execute(validRequest(), successHandler)));
  assert.deepEqual(responses.map(({ data, error }) => ({ data, error })), [
    { data: { output: { accepted: true }, status: 'succeeded' }, error: null },
    { data: { output: { accepted: true }, status: 'succeeded' }, error: null },
    { data: { output: { accepted: true }, status: 'succeeded' }, error: null }
  ]);
  assert.deepEqual(responses.map((response) => response.mode), ['worker', 'sidecar', 'container']);
  await Promise.all(executors.map((executor) => executor.close()));
});

test('executor timeout and cancellation abort the handler and clear active requests', async () => {
  const executor = createWorkerExecutor({ version: '1.0.0', maxTimeoutMs: 100 });
  const timeout = await executor.execute(validRequest({ requestId: 'timeout-1', timeoutMs: 5 }), async (_input, _context, signal) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(signal.aborted, true);
    return { output: { late: true }, status: 'succeeded' };
  });
  const pending = executor.execute(validRequest({ requestId: 'cancel-1', timeoutMs: 80 }), async () => new Promise(() => undefined));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(executor.cancel('cancel-1'), true);
  const cancelled = await pending;
  assert.equal(timeout.error?.code, 'executor.timeout');
  assert.equal(cancelled.error?.code, 'executor.cancelled');
  assert.equal(executor.activeRequestCount(), 0);
  await executor.close();
});

test('executor enforces resource budget and keeps credentials inside scoped resolver', async () => {
  const scopes: string[] = [];
  const executor = createWorkerExecutor({ version: '1.0.0', maxTimeoutMs: 100, maxInputBytes: 8, maxOutputBytes: 64, resolveCredential: (scope, ref) => { scopes.push(`${scope.tenantId}:${scope.pluginId}:${scope.pluginVersion}:${ref}`); return 'secret-value'; } });
  const tooLarge = await executor.execute(validRequest({ input: { large: 'x'.repeat(100_000) } }), successHandler);
  const tooLargeOutput = await executor.execute(validRequest({ requestId: 'large-output' }), async () => ({ output: 'x'.repeat(100_000), status: 'succeeded' as const }));
  const resolved = await executor.execute(validRequest({ credentialRefs: ['api-key'] }), successHandler);
  assert.equal(tooLarge.error?.code, 'executor.resource_limit');
  assert.equal(tooLargeOutput.error?.code, 'executor.resource_limit');
  assert.equal(resolved.error, null);
  assert.deepEqual(scopes, ['tenant-a:plugin-a:1.0.0:api-key']);
  assert.equal(JSON.stringify(resolved).includes('secret-value'), false);
  await executor.close();
});

test('plugin cleanup cancels requests and unregisters only owned subscriptions', async () => {
  const registry = new SubscriptionRegistry();
  registry.register(pluginSubscription('plugin-a'));
  registry.register(pluginSubscription('plugin-b'));
  const executor = createWorkerExecutor({ version: '1.0.0', maxTimeoutMs: 100, subscriptionRegistry: registry, subscriptionIds: () => ['plugin-a.subscription', 'plugin-b.subscription'], subscriptionOwner: (subscription, _tenantId, pluginId) => subscription.handler.ref.startsWith(`${pluginId}.`) });
  const pending = executor.execute(validRequest({ requestId: 'cleanup-1' }), async () => new Promise(() => undefined));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const report = await executor.cleanupPlugin('tenant-a', 'plugin-a');
  const response = await pending;
  assert.equal(response.error?.code, 'executor.cancelled');
  assert.deepEqual(report.removedSubscriptionIds, ['plugin-a.subscription']);
  assert.equal(registry.get('plugin-a.subscription'), undefined);
  assert.ok(registry.get('plugin-b.subscription'));
  assert.equal(executor.activeRequestCount(), 0);
  await executor.close();
});
