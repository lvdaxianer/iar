/** 验证 Function 固定响应信封和自定义 Schema 的启动编译边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ERROR_CODES, validateFunctionHandlerResult, validateFunctionResponse, type FunctionResponse } from '@iar/contracts';
import { PluginHost } from '@iar/plugins';
import { loadBusinessManifest, pluginPackage } from './fixtures/plugin-package.js';

test('FunctionResponse 支持 model/direct/none 三种模式并拒绝越权字段', () => {
  const valid: FunctionResponse[] = [
    { schemaVersion: 'iar.function-response/v1', mode: 'model', ui: { kind: 'summary' } },
    { schemaVersion: 'iar.function-response/v1', mode: 'direct', text: '已将限流调整为 50 次' },
    { schemaVersion: 'iar.function-response/v1', mode: 'none', ui: { kind: 'confirmation' } }
  ];
  valid.forEach((response) => assert.equal(validateFunctionResponse(response).ok, true));
  assert.equal(validateFunctionResponse({ schemaVersion: 'iar.function-response/v1', mode: 'direct' }).ok, false);
  assert.equal(validateFunctionResponse({ schemaVersion: 'iar.function-response/v1', mode: 'none', text: '不能出现在聊天中' }).ok, false);
  assert.equal(validateFunctionResponse({ schemaVersion: 'iar.function-response/v1', mode: 'unknown' }).ok, false);
  assert.equal(validateFunctionResponse({ schemaVersion: 'iar.function-response/v1', mode: 'direct', text: 'x'.repeat(4001) }).ok, false);
  assert.equal(validateFunctionHandlerResult({ output: { accepted: true }, status: 'succeeded' }).ok, false);
  assert.equal(validateFunctionHandlerResult({ output: { accepted: true }, status: 'succeeded', response: { schemaVersion: 'iar.function-response/v1', mode: 'direct', text: 'ok' }, secret: 'not-allowed' }).ok, false);
});

test('PluginHost 启动阶段编译自定义 Function 输入 Schema 并原子拒绝无效注册', () => {
  const host = new PluginHost();
  const invalidInput = pluginPackage(loadBusinessManifest(), 'custom.invalid-input-schema', {
    inputSchema: { $ref: '#/$defs/missing' }
  });
  const invalidOutput = pluginPackage(loadBusinessManifest(), 'custom.invalid-output-schema', {
    outputSchema: { $ref: '#/$defs/missing' }
  });

  const inputResult = host.install(invalidInput);
  const outputResult = host.install(invalidOutput);

  assert.equal(inputResult.ok, false);
  assert.equal(outputResult.ok, false);
  if (!inputResult.ok) assert.equal(inputResult.error.code, ERROR_CODES.INVALID_EMBEDDED_SCHEMA);
  if (!outputResult.ok) assert.equal(outputResult.error.code, ERROR_CODES.INVALID_EMBEDDED_SCHEMA);
  assert.equal(host.get(invalidInput.manifest.pluginId), undefined);
  assert.equal(host.get(invalidOutput.manifest.pluginId), undefined);
});
