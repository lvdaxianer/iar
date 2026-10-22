/**
 * 验证 PluginHost 的 Plugin→Function/Operation 嵌套工具投影。
 *
 * 测试只检查 OpenAI tool 结构和宿主侧所有权映射，不调用真实模型或 Handler。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSIONS, type BusinessPluginManifest, type PluginOperation } from '@iar/contracts';
import { PluginHost, validateNestedPluginTool } from '@iar/plugins';
import { pluginPackage } from '../contract/fixtures/plugin-package.js';

function packageWith(pluginId: string, functionId: string, operationNames: string[]) {
  const manifest: BusinessPluginManifest = {
    apiVersion: 'iar.dev/v1',
    schemaVersion: SCHEMA_VERSIONS.pluginManifest,
    pluginId,
    pluginKind: 'business',
    scope: 'plugin',
    version: '1.0.0',
    description: `${pluginId} 能力插件`,
    capabilities: ['test.read'],
    lifecycle: { entrypoint: `${pluginId}.entry` },
    policy: { riskLevel: 'low', requiresConfirmation: false, allowedCapabilities: ['test.read'] },
    dependencies: []
  };
  const item = pluginPackage(manifest, functionId, { actionTypes: ['query'], description: `${functionId} 查询能力` });
  const operations: PluginOperation[] = operationNames.map((name) => ({ name, kind: 'read', description: `${name} 操作` }));
  item.functions[0]!.operations = operations;
  return item;
}

function enabledHost(packages: ReturnType<typeof packageWith>[]): PluginHost {
  const host = new PluginHost();
  assert.equal(host.installAll(packages).ok, true);
  packages.forEach((item) => assert.equal(host.enable(item.manifest.pluginId).ok, true));
  return host;
}

test('each enabled Plugin is projected as one OpenAI-compatible nested tool', () => {
  const host = enabledHost([
    packageWith('ticket-plugin', 'ticket', ['query', 'create']),
    packageWith('report-plugin', 'report', ['query'])
  ]);

  const bindings = host.nestedTools();
  assert.deepEqual(bindings.map((binding) => binding.pluginId), ['report-plugin', 'ticket-plugin']);
  assert.equal(bindings.length, 2);
  assert.equal(bindings.every((binding) => validateNestedPluginTool(binding.tool).ok), true);
  assert.deepEqual(bindings.find((binding) => binding.pluginId === 'ticket-plugin')?.candidates[0]?.operations.map((operation) => operation.name), ['query', 'create']);
  assert.deepEqual(bindings.find((binding) => binding.pluginId === 'ticket-plugin')?.tool.function.parameters.properties, {
    functionId: { type: 'string', enum: ['ticket'] },
    operation: { type: 'string', enum: ['query', 'create'] },
    arguments: { type: 'object', additionalProperties: true, description: '必须符合所选 Function 的 inputSchema' }
  });
});

test('disabled or unauthorized Plugins do not enter nested tools', () => {
  const host = enabledHost([
    packageWith('enabled-plugin', 'enabled', ['query']),
    packageWith('disabled-plugin', 'disabled', ['query']),
    packageWith('unauthorized-plugin', 'unauthorized', ['query'])
  ]);
  assert.equal(host.disable('disabled-plugin').ok, true);

  const bindings = host.nestedTools({ authorize: (record) => record.manifest.pluginId !== 'unauthorized-plugin' });
  assert.deepEqual(bindings.map((binding) => binding.pluginId), ['enabled-plugin']);
});

test('ten Plugins and twenty-eight Operations preserve complete nested mapping', () => {
  const packages = Array.from({ length: 10 }, (_, index) => packageWith(
    `plugin-${String(index + 1).padStart(2, '0')}`,
    `function-${String(index + 1).padStart(2, '0')}`,
    Array.from({ length: index < 8 ? 3 : 2 }, (_, operationIndex) => `operation-${operationIndex + 1}`)
  ));
  const host = enabledHost(packages);
  const bindings = host.nestedTools();

  assert.equal(bindings.length, 10);
  assert.equal(bindings.reduce((total, binding) => total + binding.candidates.reduce((count, candidate) => count + candidate.operations.length, 0), 0), 28);
  assert.equal(new Set(bindings.map((binding) => binding.toolName)).size, 10);
  assert.equal(bindings.every((binding) => binding.candidates.every((candidate) => candidate.pluginId === binding.pluginId)), true);
});
