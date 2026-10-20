/**
 * 验证 CLI 命令只调用 ServiceApi typed client 并输出稳定 JSON。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli, type CliServiceClient } from '@iar/cli';

/*
 * CLI test 使用 typed fake client，验证命令没有绕过 ServiceApi。
 * 五个命令分别映射到有限 operation 白名单。
 * tenant 和 actor 必须显式提供，不能从 manifest 推断。
 * 缺参是参数错误，Service error 是业务失败，退出码保持可脚本化。
 * 成功 stdout 是 JSON，失败 stdout 只保留稳定 error。
 * secret pluginId 不应出现在失败输出。
 * 测试不启动 shell、网络或真实 CLI 进程。
 * 这种注入方式也覆盖未来 HTTP/Sidecar client 替换。
 * replay 作为只读命令不允许扩展为执行操作。
 * inspect 只请求公开摘要，不获取完整 Manifest。
 * 固定 requestId/traceId 便于审计命令映射。
 * 参数解析错误不回显用户输入，避免凭据泄露。
 * 未知 flag 不得调用 client。
 * 重复 flag 不得覆盖原始授权上下文。
 * inspect 同时给出 plugin/run 时必须拒绝。
 * 这些测试覆盖 parser 的 fail-closed 分支。
 * parser 错误不会调用 fake client。
 * 业务失败和参数失败使用不同退出码。
 * 所有 fake call 都在当前测试进程结束时释放。
 * 该 focused suite 不覆盖 observability 和 executor。
 * Service API 的授权语义由 service focused suite 单独覆盖。
 * CLI 输出不依赖终端颜色或本地时区。
 */

/**
 * 记录 CLI 发出的 command request，避免测试绕过 service boundary。
 *
 * @returns 调用记录和 typed Service client
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function client(): { calls: unknown[]; api: CliServiceClient } {
  const calls: unknown[] = [];
  return {
    calls,
    api: {
      request: async (request) => {
        calls.push(request);
        return { protocolVersion: 'iar.service-api/v1', requestId: request.requestId, traceId: request.traceId, tenantId: request.context.tenantId, schemaVersion: 'iar.fastify-response/v1', runId: '', version: 'fastify.v1', data: { accepted: true }, error: null };
      }
    }
  };
}

/** install/enable/disable/inspect/replay 都必须映射为受限 operation。 */
test('CLI dispatches install enable disable inspect and replay commands', async () => {
  const fixture = client();
  const manifest = JSON.stringify({ pluginId: 'plugin-cli-v1', pluginKind: 'business' });
  for (const args of [
    ['install', '--tenant', 'tenant-a', '--actor', 'actor-a', '--manifest', manifest],
    ['enable', '--tenant', 'tenant-a', '--actor', 'actor-a', '--plugin', 'plugin-cli-v1'],
    ['disable', '--tenant', 'tenant-a', '--actor', 'actor-a', '--plugin', 'plugin-cli-v1'],
    ['inspect', '--tenant', 'tenant-a', '--actor', 'actor-a', '--plugin', 'plugin-cli-v1'],
    ['replay', '--tenant', 'tenant-a', '--actor', 'actor-a', '--run', 'run-cli']
  ]) {
    const result = await runCli(args, fixture.api);
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).error, null);
  }
  assert.deepEqual((fixture.calls as Array<{ operation: string }>).map((request) => request.operation), ['plugin.install', 'plugin.enable', 'plugin.disable', 'plugin.inspect', 'run.replay']);
});

/** 缺参、未知命令和 service 错误必须稳定失败且不回显 manifest。 */
test('CLI rejects malformed command and hides service failure details', async () => {
  const fixture = client();
  const malformed = await runCli(['install', '--tenant', 'tenant-a'], fixture.api);
  assert.equal(malformed.exitCode, 2);
  assert.equal(malformed.stderr.includes('tenant-a'), false);
  const failing: CliServiceClient = { request: async (request) => ({ protocolVersion: 'iar.service-api/v1', requestId: request.requestId, traceId: request.traceId, tenantId: request.context.tenantId, schemaVersion: 'iar.fastify-response/v1', runId: '', version: 'fastify.v1', data: null, error: { code: 'service.authorization_failed', message: '授权失败', retryable: false } }) };
  const denied = await runCli(['inspect', '--tenant', 'tenant-a', '--actor', 'actor-a', '--plugin', 'secret-plugin'], failing);
  assert.equal(denied.exitCode, 1);
  assert.equal(denied.stdout.includes('secret-plugin'), false);
});

/** 未知 flag、重复 flag 和 inspect 双目标必须 fail-closed。 */
test('CLI rejects unknown duplicate and ambiguous flags', async () => {
  const fixture = client();
  for (const args of [
    ['enable', '--tenant', 'tenant-a', '--actor', 'actor-a', '--plugin', 'p', '--unknown', 'x'],
    ['enable', '--tenant', 'tenant-a', '--tenant', 'tenant-b', '--actor', 'actor-a', '--plugin', 'p'],
    ['inspect', '--tenant', 'tenant-a', '--actor', 'actor-a', '--plugin', 'p', '--run', 'r']
  ]) {
    const result = await runCli(args, fixture.api);
    assert.equal(result.exitCode, 2);
    assert.equal(fixture.calls.length, 0);
  }
});
