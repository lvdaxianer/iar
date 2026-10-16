/**
 * 提供 Phase 1 的可安装、可执行、可卸载 fake plugin 演示。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { FunctionPluginManifest, JsonValue } from '@iar/contracts';
import type { PluginHandler, PluginRegistration } from '@iar/plugin-sdk';

/** fake stop plugin 的稳定 Manifest，模拟高风险服务停止能力。 */
const fakeStopManifest: FunctionPluginManifest = {
  apiVersion: 'iar.dev/v1',
  schemaVersion: 'iar.plugin-manifest/v1',
  pluginId: 'fake-dip-stop-v1',
  pluginKind: 'function',
  scope: 'function',
  functionId: 'dip.service.stop',
  version: '1.0.0',
  description: '用于 Phase 1 生命周期和重放演示的内存 DIP 服务停止插件',
  capabilities: ['dip.service.write'],
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { serviceId: { type: 'string', minLength: 1 } },
    required: ['serviceId'],
    additionalProperties: false
  },
  outputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    oneOf: [
      {
        type: 'object',
        properties: { accepted: { const: true }, serviceId: { type: 'string', minLength: 1 } },
        required: ['accepted', 'serviceId'],
        additionalProperties: false
      },
      {
        type: 'object',
        properties: { accepted: { const: false }, errorCode: { type: 'string', minLength: 1 } },
        required: ['accepted', 'errorCode'],
        additionalProperties: false
      }
    ]
  },
  lifecycle: {
    entrypoint: './dist/examples/fake-plugin/src/index.js',
    onLoad: 'onLoad',
    onEnable: 'onEnable',
    onDisable: 'onDisable',
    onUnload: 'onUnload'
  },
  policy: {
    riskLevel: 'high',
    requiresConfirmation: true,
    allowedCapabilities: ['dip.service.write']
  },
  dependencies: []
};

/**
 * 从 JSON 输入中读取合法的 serviceId。
 *
 * @param input - SDK 传入的 JSON 输入
 * @returns 合法服务标识或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function serviceIdOf(input: JsonValue): string | undefined {
  // 输入必须是对象，拒绝 null、数组和原子 JSON 值。
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  // additionalProperties: false 的运行时等价检查。
  if (Object.keys(input).some((key) => key !== 'serviceId')) return undefined;
  const serviceId = input.serviceId;
  // 空标识不能进入 fake 副作用结果。
  return typeof serviceId === 'string' && serviceId.length > 0 ? serviceId : undefined;
}

/**
 * fake 插件加载生命周期钩子，演示宿主可绑定的入口。
 *
 * @returns 已完成的异步生命周期信号
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export async function onLoad(): Promise<void> {
  // fake 插件不初始化外部资源。
  return Promise.resolve();
}

/**
 * fake 插件启用生命周期钩子，真实实现不产生外部副作用。
 *
 * @returns 已完成的异步生命周期信号
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export async function onEnable(): Promise<void> {
  // Host 状态与 Hook 函数保持解耦。
  return Promise.resolve();
}

/**
 * fake 插件禁用生命周期钩子。
 *
 * @returns 已完成的异步生命周期信号
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export async function onDisable(): Promise<void> {
  // 没有真实连接需要释放。
  return Promise.resolve();
}

/**
 * fake 插件卸载生命周期钩子。
 *
 * @returns 已完成的异步生命周期信号
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export async function onUnload(): Promise<void> {
  // 没有真实订阅或句柄需要清理。
  return Promise.resolve();
}

/**
 * fake Handler 只返回确定性结果，不产生真实外部副作用。
 *
 * @param input - SDK 传入的 JSON 输入
 * @returns 符合 Manifest 输出 Schema 的成功或失败结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
const fakeStopHandler: PluginHandler = async (input) => {
  // 输入边界先于任何业务字段读取。
  const serviceId = serviceIdOf(input);
  if (!serviceId) {
    // 错误码稳定且不暴露原始输入。
    return { output: { accepted: false, errorCode: 'fake.invalid_service_id' }, status: 'failed', errorCode: 'fake.invalid_service_id' };
  }
  // 成功结果严格对应 outputSchema 的第一分支。
  return { output: { accepted: true, serviceId }, status: 'succeeded' };
};

/** 可直接交给 PluginHost.install 的 fake plugin 注册对象。 */
export const fakeStopPlugin: PluginRegistration = {
  manifest: fakeStopManifest,
  handler: fakeStopHandler
};
