/**
 * 从构建产物运行 Phase 1 fake plugin 演示。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import { createIarAgent } from '@iar/agent';
import { replayEvents } from '@iar/runtime';
import { fakeStopPlugin } from '../dist/examples/plugins/fake-plugin/src/index.js';

// 演示入口只使用构建产物，避免文档示例依赖不存在的源码 .js 文件。
// npm run demo:fake-plugin 会先生成 dist，再执行本文件。
// 统一入口负责校验、安装、启用，并从 Plugin 包派生 Function 索引。
const host = createIarAgent({ plugins: [fakeStopPlugin] }).pluginHost;
const candidate = host.resolveCandidate('dip.service.stop', fakeStopPlugin.manifest.pluginId);
// resolveCandidate 同时检查 Function 归属和 enabled 状态。
assert.equal(candidate.ok, true);
if (candidate.ok) {
  // Handler 只模拟成功结果，不触发真实外部副作用。
  const functionRecord = candidate.value.functions.get('dip.service.stop');
  assert.ok(functionRecord);
  const result = await functionRecord.handler(
    { serviceId: 'test1' },
    { pluginId: fakeStopPlugin.manifest.pluginId, functionId: 'dip.service.stop', runId: 'run-demo', correlationId: 'corr-demo' }
  );
  assert.deepEqual(result?.output, { accepted: true, serviceId: 'test1' });
}
assert.equal(host.disable(fakeStopPlugin.manifest.pluginId).ok, true);
// disabled 会撤销新的路由候选，但保留可卸载注册记录。
assert.equal(host.unload(fakeStopPlugin.manifest.pluginId).ok, true);
// unload 后当前能力消失，历史事件仍可读取。
// 卸载后仍从历史事件重放最后恢复边界。
const replayed = replayEvents(host.events);
// 输出完整生命周期和重放边界，供人工演示和脚本检查。
console.log(JSON.stringify({ lifecycle: host.history(fakeStopPlugin.manifest.pluginId).map((event) => event.eventName), replayedLastEventId: replayed.integrity.lastEventId }, null, 2));
