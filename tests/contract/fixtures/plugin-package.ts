/** 提供契约测试复用的 Plugin > Function > Operation 测试包。 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_VERSIONS, type BusinessPluginManifest, type FunctionDefinition, type PluginOperation } from '@iar/contracts';
import type { FunctionHandler, PluginPackage } from '@iar/plugin';

/** 读取新的包级业务 Manifest fixture。 */
export function loadBusinessManifest(): BusinessPluginManifest {
  const path = join(process.cwd(), 'tests', 'contract', 'fixtures', 'valid-plugin-manifest.json');
  return JSON.parse(readFileSync(path, 'utf8')) as BusinessPluginManifest;
}

/** 构造一个带直接 Manifest 字段投影的测试包，方便旧测试逐步迁移到嵌套 Function。 */
export function pluginPackage(manifest: BusinessPluginManifest, functionId = 'dip.service.stop', functionOverrides: Partial<FunctionDefinition> = {}): PluginPackage & BusinessPluginManifest {
  const definition: FunctionDefinition = {
    schemaVersion: SCHEMA_VERSIONS.function,
    functionId,
    version: manifest.version,
    name: manifest.description,
    description: manifest.description,
    actionTypes: ['execute'],
    inputSchema: { type: 'object', additionalProperties: true },
    outputSchema: { type: 'object', additionalProperties: true },
    capabilities: [...manifest.capabilities],
    riskLevel: manifest.policy.riskLevel,
    ...functionOverrides,
  };
  const operations: PluginOperation[] = [{ name: 'execute', kind: 'action', description: '执行测试能力' }];
  const handler: FunctionHandler = async () => ({ output: null, status: 'succeeded', response: { schemaVersion: 'iar.function-response/v1', mode: 'model' } });
  return { ...manifest, manifest, functions: [{ definition, operations, handler }] };
}
