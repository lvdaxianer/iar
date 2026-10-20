/** 验证 Plugin > Function > Operation 的新公共注册契约。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { defineFunction, definePlugin, type FunctionHandler } from '@iar/plugin';
import { SCHEMA_VERSIONS, type FunctionDefinition } from '@iar/contracts';

const handler: FunctionHandler = async () => ({ output: { ok: true }, status: 'succeeded' });

/** 构造测试用 Function 定义，保持每个测试只关注注册层行为。 */
function functionDefinition(functionId: string, overrides: Partial<FunctionDefinition> = {}): FunctionDefinition {
  return {
    schemaVersion: SCHEMA_VERSIONS.function,
    functionId,
    version: '1.0.0',
    name: functionId,
    description: `${functionId} capability`,
    actionTypes: ['query'],
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object', additionalProperties: false },
    capabilities: ['ticket.read'],
    riskLevel: 'low',
    ...overrides
  };
}

/** 构造测试用 Plugin 包，验证所有 Function 都从 Plugin 边界进入。 */
function ticketPlugin() {
  return definePlugin({
    manifest: {
      apiVersion: 'iar.dev/v1',
      schemaVersion: SCHEMA_VERSIONS.pluginManifest,
      pluginId: 'ticket-system',
      pluginKind: 'business',
      scope: 'plugin',
      version: '1.0.0',
      description: '工单能力包',
      capabilities: ['ticket.read'],
      lifecycle: { entrypoint: '@iar/plugin-ticket' },
      policy: { riskLevel: 'low', requiresConfirmation: false, allowedCapabilities: ['ticket.read'] },
      dependencies: []
    },
    functions: [
      defineFunction({ definition: functionDefinition('ticket.query'), operations: [], handler }),
      defineFunction({ definition: functionDefinition('ticket.create', { actionTypes: ['create'] }), operations: [], handler })
    ]
  });
}

test('one Plugin owns multiple independently routable Functions', () => {
  const plugin = ticketPlugin();
  assert.deepEqual(plugin.functions.map((item) => item.definition.functionId), ['ticket.query', 'ticket.create']);
  assert.equal(plugin.manifest.pluginId, 'ticket-system');
});

test('duplicate Function IDs are rejected inside one Plugin package', () => {
  assert.throws(() => definePlugin({
    manifest: ticketPlugin().manifest,
    functions: [
      defineFunction({ definition: functionDefinition('ticket.query'), operations: [], handler }),
      defineFunction({ definition: functionDefinition('ticket.query'), operations: [], handler })
    ]
  }), /duplicate|重复/i);
});

test('Function capabilities must be contained by the Plugin capability boundary', () => {
  assert.throws(() => definePlugin({
    manifest: ticketPlugin().manifest,
    functions: [defineFunction({ definition: functionDefinition('ticket.query', { capabilities: ['ticket.write'] }), operations: [], handler })]
  }), /capabilit|能力/i);
});

test('old Function-first Manifest fields are rejected', () => {
  const legacyShape = { ...ticketPlugin().manifest, functionId: 'ticket.query', actionTypes: ['query'] };
  assert.throws(() => definePlugin({ manifest: legacyShape, functions: [] }), /function|scope|business|invalid|字段/i);
});
