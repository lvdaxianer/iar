# Phase 1 fake plugin 演示

`examples/plugins/fake-plugin/src/index.ts` 提供一个不产生真实外部副作用的 `dip.service.stop` Plugin 包。它使用 `Plugin > Function > Operation` 注册模型声明输入输出 Schema、能力和高风险确认策略，但 Handler 只返回确定性 JSON 结果。

从仓库根目录执行 `npm run demo:fake-plugin` 可直接运行构建后的演示；对应自动化断言见 [`tests/contract/fake-plugin-demo.test.ts`](../../../tests/contract/fake-plugin-demo.test.ts)。

## 安装与执行

```ts
// 该片段对应 scripts/run-fake-plugin-demo.mjs；请从仓库根目录运行 npm run demo:fake-plugin。
import { createIarAgent } from '../../dist/packages/agent/src/index.js';
import { replayEvents } from '../../dist/packages/runtime/src/index.js';
import { fakeStopPlugin } from '../../dist/examples/plugins/fake-plugin/src/index.js';

const host = createIarAgent({ plugins: [fakeStopPlugin] }).pluginHost;

const plugin = host.resolveCandidate('dip.service.stop', 'fake-dip-stop-v1');
if (plugin.ok) {
  await plugin.value.handler(
    { serviceId: 'test1' },
    {
      pluginId: 'fake-dip-stop-v1',
      functionId: 'dip.service.stop',
      runId: 'run-fake',
      correlationId: 'corr-fake'
    }
  );
}
```

Handler 的成功结果为：

```json
{
  "output": { "accepted": true, "serviceId": "test1" },
  "status": "succeeded"
}
```

## 生命周期和重放

进入 `draining` 或 `disabled` 后才能 `unload`。插件历史事件保留以下顺序，卸载不会从历史中删除事件：

```text
plugin.discovered
plugin.validated
plugin.installed
plugin.enabled
plugin.disabled
plugin.unloaded
```

`PluginHost.events` 返回不可变快照，事件可以交给 `replayEvents()` 做确定性重放；演示测试见 [`tests/contract/fake-plugin-demo.test.ts`](../../../tests/contract/fake-plugin-demo.test.ts)。
