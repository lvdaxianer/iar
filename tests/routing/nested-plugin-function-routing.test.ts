/**
 * 验证嵌套 Plugin 工具和 Function Calling 提案的基础契约。
 *
 * 该测试只覆盖模型传输边界，不执行真实 Handler，也不负责主路由集成。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNestedFunctionCallProposal,
  normalizePluginToolName,
  validateNestedPluginTool,
  type NestedPluginTool
} from '@iar/plugins';

const parameters = {
  type: 'object',
  properties: {
    ticketId: { type: 'string' },
    priority: { type: 'string', enum: ['low', 'high'] }
  },
  required: ['ticketId'],
  additionalProperties: false
} as const;

function tool(name = 'plugin_ticket'): NestedPluginTool {
  return {
    type: 'function',
    function: {
      name,
      description: '工单能力，提供查询和创建操作',
      parameters: {
        type: 'object',
        properties: {
          functionId: { type: 'string', enum: ['ticket'] },
          operation: { type: 'string', enum: ['query', 'create'] },
          arguments: parameters
        },
        required: ['functionId', 'operation', 'arguments'],
        additionalProperties: false
      }
    }
  };
}

test('Plugin tool name is normalized to the OpenAI-compatible character and length limits', () => {
  const name = normalizePluginToolName('api.gateway/order');
  assert.match(name, /^[a-zA-Z0-9_-]+$/);
  assert.equal(name.length <= 64, true);
  assert.equal(normalizePluginToolName('api.gateway/order'), name);
});

test('nested Plugin tool validates its object parameters and Function candidates', () => {
  const result = validateNestedPluginTool(tool());
  assert.equal(result.ok, true);
});

test('nested Plugin tool rejects provider-unsupported schema keywords', () => {
  const invalid = tool();
  invalid.function.parameters = {
    type: 'object',
    properties: {},
    oneOf: [{ type: 'object' }]
  };
  const result = validateNestedPluginTool(invalid);
  assert.equal(result.ok, false);
});

test('nested Plugin tool rejects malformed runtime input without throwing', () => {
  const result = validateNestedPluginTool({ type: 'function', function: null });
  assert.equal(result.ok, false);
});

test('nested Function Calling proposal preserves named arguments and ownership', () => {
  const result = createNestedFunctionCallProposal({
    schemaVersion: 'iar.nested-function-call/v1',
    pluginId: 'ticket-plugin',
    toolName: 'plugin_ticket',
    functionId: 'ticket',
    operation: 'query',
    arguments: { ticketId: 'ticket-1' },
    confidence: 0.95
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.arguments, { ticketId: 'ticket-1' });
    assert.equal(result.value.pluginId, 'ticket-plugin');
    assert.equal(result.value.operation, 'query');
  }
});

test('nested Function Calling proposal rejects non-object arguments', () => {
  const result = createNestedFunctionCallProposal({
    schemaVersion: 'iar.nested-function-call/v1',
    pluginId: 'ticket-plugin',
    toolName: 'plugin_ticket',
    functionId: 'ticket',
    operation: 'query',
    arguments: 'ticket-1',
    confidence: 0.95
  });
  assert.equal(result.ok, false);
});
