/**
 * 验证 Phase 3 三个示例插件的 Manifest、Handler 和 Function/Policy 边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FunctionPluginManifest, JsonValue, PluginManifest } from '../../../packages/contracts/src/index.js';
import { PluginHost, type PluginRecord } from '../../../packages/plugin-host/src/index.js';
import type { PluginHandlerResult, PluginRegistration } from '../../../packages/plugin-sdk/src/index.js';
import { knowledgeQueryPlugin } from '../../../examples/knowledge-query/src/index.js';
import { ticketCreatePlugin } from '../../../examples/ticket-create/src/index.js';
import { humanTransferPlugin } from '../../../examples/human-transfer/src/index.js';

/** 三个示例必须使用不同且稳定的 Function 归属。 */
type ExampleRegistration = PluginRegistration & { manifest: FunctionPluginManifest };
type ExampleManifestTuple = [FunctionPluginManifest, FunctionPluginManifest, FunctionPluginManifest];
type ExampleRecordTuple = [PluginRecord, PluginRecord, PluginRecord];
const registrations: readonly ExampleRegistration[] = [knowledgeQueryPlugin as ExampleRegistration, ticketCreatePlugin as ExampleRegistration, humanTransferPlugin as ExampleRegistration];

/**
 * 创建覆盖三个示例 Function 的本地 PluginHost。
 *
 * @returns 可安装示例插件的 Host
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function host(): PluginHost {
  return new PluginHost({ functionIds: registrations.map(({ manifest }) => manifest.functionId) });
}

/**
 * 安装并启用所有示例插件，返回隔离后的 Host 记录。
 *
 * @returns 已启用的示例记录
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function enabledRecords(): ExampleRecordTuple {
  const pluginHost = host();
  const installed = pluginHost.installAll([...registrations]);
  assert.equal(installed.ok, true);
  registrations.forEach(({ manifest }) => assert.equal(pluginHost.enable(manifest.pluginId).ok, true));
  const records = registrations.map(({ manifest }) => {
    const record = pluginHost.get(manifest.pluginId);
    if (!record) throw new Error(`示例插件未安装: ${manifest.pluginId}`);
    return record;
  });
  return records as ExampleRecordTuple;
}

/**
 * 返回三个 manifest 的固定元组，避免 noUncheckedIndexedAccess 丢失示例身份。
 *
 * @returns knowledge、ticket、human transfer 三个 Manifest
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function manifests(): ExampleManifestTuple {
  return registrations.map(({ manifest }) => manifest) as ExampleManifestTuple;
}

/**
 * 证明由示例注册的 Manifest 必须是 Function Plugin。
 *
 * @param manifest - PluginHost 返回的 Manifest
 * @returns 具有唯一 Function ownership 的 Manifest
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function functionManifest(manifest: PluginManifest): FunctionPluginManifest {
  if (manifest.pluginKind !== 'function') throw new Error(`示例插件不能是 system plugin: ${manifest.pluginId}`);
  return manifest;
}

/**
 * 使用 Ajv 验证示例输入/输出 Schema。
 *
 * @param schema - Manifest 内嵌 JSON Schema
 * @param value - 待验证值
 * @returns 是否通过 Schema
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function matchesSchema(schema: Record<string, unknown>, value: unknown): boolean {
  return new Ajv2020({ strict: false }).compile(schema)(value);
}

/**
 * 执行指定示例 Handler 并断言返回值是 JSON-safe 的 HandlerResult。
 *
 * @param record - 已启用的示例记录
 * @param input - 测试输入
 * @returns Handler 结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
async function execute(record: PluginRecord, input: JsonValue): Promise<PluginHandlerResult> {
  assert.ok(record.handler);
  const result = await record.handler(input, { pluginId: record.manifest.pluginId, functionId: functionManifest(record.manifest).functionId, runId: 'run-example', correlationId: 'trace-example' });
  assert.ok(result);
  assert.equal(typeof result.status, 'string');
  return result;
}

/**
 * 三个示例都能被真实 PluginHost 安装、启用并保留唯一 Function ownership。
 * 安装结果来自 Host 快照，而不是直接断言导出的静态常量。
 * 每个记录都必须保持 function scope 和 enabled 状态。
 */
test('installs examples with one Function ownership each', () => {
  const records = enabledRecords();
  assert.deepEqual(records.map(({ manifest }) => manifest.pluginId), ['knowledge-query-v1', 'ticket-create-v1', 'human-transfer-v1']);
  assert.deepEqual(records.map(({ manifest }) => functionManifest(manifest).functionId), ['knowledge.query', 'ticket.create', 'human.transfer']);
  records.forEach((record) => {
    assert.equal(record.state, 'enabled');
    assert.equal(record.manifest.pluginKind, 'function');
    assert.equal(record.manifest.scope, 'function');
  });
});

/**
 * Manifest 的 capability、risk 和 confirmation 必须与三个业务边界一致。
 * read 能力保持低风险；写入和人工转交必须要求确认。
 * allowedCapabilities 不能超出 Manifest capabilities。
 */
test('keeps capability and confirmation policy aligned with risk', () => {
  const [knowledge, ticket, transfer] = manifests();
  assert.equal(knowledge.policy.riskLevel, 'low');
  assert.equal(knowledge.policy.requiresConfirmation, false);
  assert.deepEqual(knowledge.capabilities, ['knowledge.read']);
  assert.equal(ticket.policy.riskLevel, 'high');
  assert.equal(ticket.policy.requiresConfirmation, true);
  assert.deepEqual(ticket.capabilities, ['ticket.write']);
  assert.equal(transfer.policy.riskLevel, 'high');
  assert.equal(transfer.policy.requiresConfirmation, true);
  assert.deepEqual(transfer.capabilities, ['human.transfer']);
  registrations.forEach(({ manifest }) => assert.deepEqual(manifest.policy.allowedCapabilities, manifest.capabilities));
});

/**
 * 合法输入必须产生符合 outputSchema 的确定性结果。
 * 同一输入重复执行得到同一 fixture，证明示例不依赖网络或时间。
 * Handler 返回值同时满足 SDK status 和 Manifest outputSchema。
 */
test('returns schema-valid deterministic outputs for all examples', async () => {
  const [knowledge, ticket, transfer] = enabledRecords();
  const knowledgeOutput = await execute(knowledge, { query: 'restart policy', topK: 3 });
  const ticketOutput = await execute(ticket, { title: 'Service incident', description: 'test1 is unavailable', priority: 'high' });
  const transferOutput = await execute(transfer, { reason: 'requires human approval', summary: 'test1 needs review' });
  assert.equal(knowledgeOutput.status, 'succeeded');
  assert.equal(ticketOutput.status, 'succeeded');
  assert.equal(transferOutput.status, 'succeeded');
  assert.equal(matchesSchema(knowledge.manifest.outputSchema, knowledgeOutput.output), true);
  assert.equal(matchesSchema(ticket.manifest.outputSchema, ticketOutput.output), true);
  assert.equal(matchesSchema(transfer.manifest.outputSchema, transferOutput.output), true);
  assert.equal(JSON.stringify(await execute(knowledge, { query: 'api-key=secret-knowledge', topK: 3 })).includes('api-key=secret-knowledge'), false);
  assert.deepEqual(knowledgeOutput, await execute(knowledge, { query: 'restart policy', topK: 3 }));
  assert.deepEqual(ticketOutput, await execute(ticket, { title: 'Service incident', description: 'test1 is unavailable', priority: 'high' }));
  assert.deepEqual(transferOutput, await execute(transfer, { reason: 'requires human approval', summary: 'test1 needs review' }));
});

/**
 * malformed/extra input 不能进入业务结果，也不能在错误中回显 secret。
 * 每个示例都测试空字段、未知字段或非法枚举。
 * 错误结果必须继续通过公共 outputSchema。
 * 失败路径不应产生可执行的成功 fixture。
 */
test('rejects malformed inputs without echoing sensitive values', async () => {
  const [knowledge, ticket, transfer] = enabledRecords();
  const cases: Array<{ record: PluginRecord; input: JsonValue; marker: string }> = [
    { record: knowledge, input: { query: '', topK: 0, apiKey: 'secret-knowledge' }, marker: 'secret-knowledge' },
    { record: ticket, input: { title: '', description: 'private ticket', priority: 'urgent' }, marker: 'private ticket' },
    { record: transfer, input: { reason: '', summary: 'Bearer internal' }, marker: 'Bearer internal' }
  ];
  for (const item of cases) {
    const result = await execute(item.record, item.input);
    assert.equal(result.status, 'failed');
    assert.equal(matchesSchema(item.record.manifest.outputSchema, result.output), true);
    assert.equal(JSON.stringify(result).includes(item.marker), false);
  }
});

/**
 * Handler 只接收 JSON-safe 输入，不能凭借额外字段动态扩展能力。
 * 额外 capability 字段必须触发失败，而不是修改 Manifest 权限。
 * 测试最后重新检查三个声明的 capability 集合。
 */
test('does not expand capabilities through input or handler output', async () => {
  const [knowledge, ticket, transfer] = enabledRecords();
  const knowledgeResult = await execute(knowledge, { query: 'known', topK: 1, capability: 'ticket.write' });
  const ticketResult = await execute(ticket, { title: 'known', description: 'known', priority: 'low', capability: 'human.transfer' });
  const transferResult = await execute(transfer, { reason: 'known', summary: 'known', capability: 'knowledge.read' });
  assert.equal(knowledgeResult.status, 'failed');
  assert.equal(ticketResult.status, 'failed');
  assert.equal(transferResult.status, 'failed');
  assert.deepEqual(knowledge.manifest.capabilities, ['knowledge.read']);
  assert.deepEqual(ticket.manifest.capabilities, ['ticket.write']);
  assert.deepEqual(transfer.manifest.capabilities, ['human.transfer']);
});
