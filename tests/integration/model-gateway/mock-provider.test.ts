/**
 * 验证真实 Provider 不可用时 Mock/安全错误路径仍可确定性完成。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ModelGateway, ModelProfileRegistry, loadModelProfiles, ModelProviderError, ResponseGeneratorAdapter } from '@iar/runtime';
import type { ModelProvider } from '@iar/runtime';

/**
 * 创建本地 response profile registry，避免测试读取真实 provider 配置。
 *
 * @returns response role 的完整 profile registry
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function registry(): ModelProfileRegistry {
  const source = readFileSync(join(process.cwd(), 'config', 'models.yaml'), 'utf8');
  return new ModelProfileRegistry(loadModelProfiles(source));
}

/**
 * 创建显式失败的 Mock Provider。
 *
 * @param kind - provider unavailable 或 provider failed 分类
 * @returns 可注入 ModelGateway 的 Mock Provider
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function unavailableProvider(kind: 'provider_unavailable' | 'provider_failed'): ModelProvider {
  return { complete: async () => { throw new ModelProviderError(kind); } };
}

/**
 * provider unavailable 只能变成稳定 fallback_failed，不能把异常正文传播给调用方。
 * primary 和 fallback 都使用同一个本地 Mock，不产生网络访问。
 */
test('maps unavailable mock provider to stable safe error', async () => {
  const gateway = new ModelGateway({ registry: registry(), providers: { mock: unavailableProvider('provider_unavailable') } });
  const result = await new ResponseGeneratorAdapter(gateway).generate({ traceId: 'trace-mock-unavailable', runId: 'run-mock-unavailable', input: { rawPrompt: 'private prompt', apiKey: 'secret-api-key' } });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'model.fallback_failed');
    assert.equal(result.error.message.includes('provider_unavailable'), false);
    assert.equal(JSON.stringify(result).includes('private prompt'), false);
    assert.equal(JSON.stringify(result).includes('secret-api-key'), false);
  }
  assert.equal(result.audit.length, 3);
  assert.equal(result.events.length, 3);
  assert.equal(result.events.every((event) => event.eventName === 'model.failed'), true);
});

/**
 * provider failed 的 Mock 同样只能进入稳定错误，不得伪造成功输出。
 * attempt 次数必须等于 profile retry 与 fallback 的明确总和。
 */
test('keeps provider failure deterministic without real network', async () => {
  let calls = 0;
  const provider: ModelProvider = { complete: async () => { calls += 1; throw new ModelProviderError('provider_failed'); } };
  const gateway = new ModelGateway({ registry: registry(), providers: { mock: provider } });
  const result = await new ResponseGeneratorAdapter(gateway).generate({ traceId: 'trace-mock-failed', runId: 'run-mock-failed', input: { prompt: 'safe fixture' } });
  assert.equal(result.ok, false);
  assert.equal(calls, 3);
  if (!result.ok) assert.deepEqual(result.error.details, { primaryCode: 'model.provider_failed', fallbackCode: 'model.provider_failed' });
});

/**
 * Mock Provider 不需要 API key 或外部网络即可完成稳定 schema-invalid 失败。
 * 原始 malformed output 不得进入公开 error、audit 或 event。
 */
test('maps malformed mock output to safe schema failure', async () => {
  // malformed output 不能绕过 role validator，也不能把 provider object 当成成功值。
  const malformed: ModelProvider = { complete: async () => ({ text: 'malformed-output-secret' }) };
  const gateway = new ModelGateway({ registry: registry(), providers: { mock: malformed } });
  const result = await new ResponseGeneratorAdapter(gateway).generate({ traceId: 'trace-mock-schema', runId: 'run-mock-schema', input: { prompt: 'safe fixture' } });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'model.fallback_failed');
    assert.equal(result.events.every((event) => event.errorCode === 'model.schema_invalid'), true);
    assert.equal(JSON.stringify(result).includes('malformed-output-secret'), false);
  }
});
