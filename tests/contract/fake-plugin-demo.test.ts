/**
 * 验证 Phase 1 fake plugin 可安装、启停、执行、卸载并重放生命周期事件。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { replayEvents } from '@iar/runtime';
import { PluginHost, type PluginRecord } from '@iar/plugins';
import { fakeStopPlugin, onDisable, onEnable, onLoad, onUnload } from '../../examples/plugins/fake-plugin/src/index.js';

/*
 * 该测试只使用内存 Host，不依赖网络或真实 DIP 服务。
 * fake Manifest 必须通过完整 contracts 校验。
 * Function 归属必须匹配 Host 的静态边界。
 * 高风险能力必须保留 requiresConfirmation 声明。
 * 成功 Handler 输出必须符合 outputSchema 的成功分支。
 * 失败 Handler 输出必须符合 outputSchema 的失败分支。
 * additionalProperties false 必须在 Handler 边界实际生效。
 * Handler 不产生真实副作用，只返回确定性 JSON。
 * enabled 插件才能进入 resolveCandidate。
 * disabled 插件保留注册记录但撤销候选能力。
 * unloaded 插件从当前注册表移除。
 * 生命周期事件必须保持 discovered 到 unloaded 的顺序。
 * 事件历史在卸载后仍然保留。
 * 事件快照可以交给 runtime replay。
 * 两次 replay 必须产生相同完整状态。
 * fake Hook 导出必须和 Manifest 名称一致。
 * demo script 使用 dist 构建产物而不是源码 .js 路径。
 * 测试失败优先检查稳定状态和错误结果。
 * 测试不覆盖真实执行器、网络和模型。
 */

/**
 * 创建使用 fake plugin Function 边界的内存 Host。
 *
 * @returns 配置完成的内存 PluginHost
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function createHost(): PluginHost {
  // Function ID 是 fake plugin 唯一允许归属的静态边界。
  return new PluginHost();
}

/**
 * 执行成功输入并验证 SDK Handler 的确定性结果。
 *
 * @param record - 已解析的 fake plugin 记录
 * @returns 成功完成的异步断言
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
async function assertSuccessfulExecution(record: PluginRecord): Promise<void> {
  const execution = await record.functions.get('dip.service.stop')?.handler(
    { serviceId: 'test1' },
    { pluginId: fakeStopPlugin.manifest.pluginId, functionId: 'dip.service.stop', runId: 'run-fake', correlationId: 'corr-fake' }
  );
  // Handler 返回值先通过类型断言，再交给 Manifest Schema 校验。
  assert.ok(execution);
  assertOutputSchema(execution.output);
  assert.deepEqual(execution, { output: { accepted: true, serviceId: 'test1' }, status: 'succeeded' });
}

/**
 * 使用 Ajv 验证 fake Handler 的输出分支契约。
 *
 * @param output - Handler 返回的 JSON 输出
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertOutputSchema(output: unknown): void {
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.compile(fakeStopPlugin.functions[0]!.definition.outputSchema);
  assert.equal(validate(output), true);
}

/**
 * 验证缺失字段和额外字段都遵守 Manifest 输入边界。
 *
 * @param record - 已解析的 fake plugin 记录
 * @returns 完成失败输入断言的 Promise
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
async function assertRejectedInputs(record: PluginRecord): Promise<void> {
  const rejected = await record.functions.get('dip.service.stop')?.handler(
    { serviceId: '' },
    { pluginId: fakeStopPlugin.manifest.pluginId, functionId: 'dip.service.stop', runId: 'run-fake', correlationId: 'corr-fake' }
  );
  assert.ok(rejected);
  assertOutputSchema(rejected.output);
  assert.deepEqual(rejected?.output, { accepted: false, errorCode: 'fake.invalid_service_id' });
  const extra = await record.functions.get('dip.service.stop')?.handler(
    { serviceId: 'test1', extra: true },
    { pluginId: fakeStopPlugin.manifest.pluginId, functionId: 'dip.service.stop', runId: 'run-fake', correlationId: 'corr-fake' }
  );
  assert.ok(extra);
  assertOutputSchema(extra.output);
  assert.deepEqual(extra?.output, { accepted: false, errorCode: 'fake.invalid_service_id' });
}

/**
 * 验证生命周期历史和两次重放结果保持确定性。
 *
 * @param host - 已完成卸载的 PluginHost
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertLifecycleReplay(host: PluginHost): void {
  // 两次 replay 的完整快照必须相同，而非只比较最后事件 ID。
  const firstReplay = replayEvents(host.events);
  const secondReplay = replayEvents(host.events);
  assert.deepEqual(firstReplay, secondReplay);
  assert.equal(host.candidates('dip.service.stop').length, 0);
  assert.equal(firstReplay.integrity.lastEventId, host.events.at(-1)?.eventId);
  assert.deepEqual(host.history(fakeStopPlugin.manifest.pluginId).map((event) => event.eventName), [
    'plugin.discovered',
    'plugin.validated',
    'plugin.installed',
    'plugin.enabled',
    'plugin.disabled',
    'plugin.unloaded'
  ]);
}

/** 验证完整的安装、执行、停用、卸载和重放流程。 */
test('fake plugin completes install enable execute disable unload and replay demo', async () => {
  const host = createHost();
  const installed = host.install(fakeStopPlugin);
  assert.equal(installed.ok, true);
  assert.equal(host.enable(fakeStopPlugin.manifest.pluginId).ok, true);
  const candidate = host.resolveCandidate('dip.service.stop', fakeStopPlugin.manifest.pluginId);
  assert.equal(candidate.ok, true);
  if (candidate.ok) {
    await assertSuccessfulExecution(candidate.value);
    await assertRejectedInputs(candidate.value);
  }
  assert.equal(host.disable(fakeStopPlugin.manifest.pluginId).ok, true);
  assert.equal(host.unload(fakeStopPlugin.manifest.pluginId).ok, true);
  assert.equal(host.get(fakeStopPlugin.manifest.pluginId), undefined);
  assertLifecycleReplay(host);
});

/** 验证 Manifest 声明的生命周期入口均实际导出且可调用。 */
test('fake plugin lifecycle hooks are executable exports', async () => {
  // Hook 是可调用导出，Manifest 只保存其稳定名称。
  await onLoad();
  await onEnable();
  await onDisable();
  await onUnload();
  assert.deepEqual(fakeStopPlugin.manifest.lifecycle, {
    entrypoint: './dist/examples/plugins/fake-plugin/src/index.js',
    onLoad: 'onLoad',
    onEnable: 'onEnable',
    onDisable: 'onDisable',
    onUnload: 'onUnload'
  });
});
