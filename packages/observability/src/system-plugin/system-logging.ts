/**
 * 提供不参与业务路由的 runtime system logging plugin。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { IAR_API_VERSION, SCHEMA_VERSIONS, validatePluginManifest, type SystemPluginManifest } from '@iar/contracts';
import type { HookHandler, HookSubscription, SubscriptionRegistry, SubscriptionDispatcher } from '@iar/subscriptions';
import { ObservabilityRecorder } from '../core/recorder.js';

const LOG_EVENTS = ['run.created', 'input.received', 'semantic.extracted', 'function.selected', 'plugin.selected', 'policy.evaluated', 'action.before', 'action.started', 'action.completed', 'action.failed', 'context.compacted', 'context.compaction_failed', 'run.completed', 'run.failed'] as const;
const SAFE_FIELDS = ['route', 'functionId', 'pluginId', 'pluginVersion', 'durationMs', 'resultCode', 'errorClass', 'policyDecision', 'confirmationState'] as const;

/** 可安装的 system logging plugin 描述。 */
const SYSTEM_LOGGING_MANIFEST: SystemPluginManifest = {
  apiVersion: IAR_API_VERSION,
  schemaVersion: SCHEMA_VERSIONS.pluginManifest,
  pluginId: 'iar.observability.log',
  pluginKind: 'system',
  scope: 'runtime',
  version: '1.0.0',
  description: 'IAR 结构化日志与审计 observer',
  capabilities: ['observability.log'],
  inputSchema: { type: 'object', additionalProperties: false },
  outputSchema: { type: 'object', additionalProperties: false },
  lifecycle: { entrypoint: 'builtin:iar.observability.log' },
  policy: { riskLevel: 'low', requiresConfirmation: false, allowedCapabilities: ['observability.log'] },
  dependencies: []
};

/** system logging plugin 使用的异步 fail-open subscriptions。 */
const SYSTEM_LOGGING_SUBSCRIPTIONS_TEMPLATE: readonly HookSubscription[] = LOG_EVENTS.map((event, index) => ({
  subscriptionId: `iar.observability.log.${event}`,
  event,
  handler: { type: 'builtin', ref: 'iar.observability.log.write' },
  delivery: 'async',
  priority: 100 - index,
  failurePolicy: 'fail-open',
  timeoutMs: 100
}));

/** 深冻结 system plugin 模板，防止调用方改变路由和订阅边界。 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

/** 导出的不可变 system logging manifest。 */
export const SYSTEM_LOGGING_PLUGIN_MANIFEST = deepFreeze(SYSTEM_LOGGING_MANIFEST);

/** 导出的不可变 system logging subscriptions。 */
export const SYSTEM_LOGGING_SUBSCRIPTIONS = deepFreeze(SYSTEM_LOGGING_SUBSCRIPTIONS_TEMPLATE);

/** system plugin 的公开实现对象。 */
export type SystemLoggingPlugin = {
  manifest: SystemPluginManifest;
  subscriptions: readonly HookSubscription[];
  subscription: HookSubscription;
  handler: HookHandler;
};

/** @param recorder - 统一观测记录器 @returns system logging plugin @author lvdaxianer@yeah.net @date 2026-10-17 */
export function createSystemLoggingPlugin(recorder: ObservabilityRecorder): SystemLoggingPlugin {
  if (!validatePluginManifest(SYSTEM_LOGGING_PLUGIN_MANIFEST).ok) throw new TypeError('system logging manifest invalid');
  const handler: HookHandler = async (event) => {
    const source = isRecord(event.payload) ? event.payload : {};
    const fields: Record<string, unknown> = { eventId: event.eventId };
    for (const field of SAFE_FIELDS) if (Object.hasOwn(source, field)) fields[field] = source[field];
    await recorder.log({ level: 'info', traceId: event.correlationId, runId: event.runId, eventName: event.eventName, fields });
    return {};
  };
  return { manifest: deepFreeze(structuredClone(SYSTEM_LOGGING_PLUGIN_MANIFEST)), subscriptions: deepFreeze(SYSTEM_LOGGING_SUBSCRIPTIONS.map((subscription) => structuredClone(subscription))), subscription: deepFreeze(structuredClone(SYSTEM_LOGGING_SUBSCRIPTIONS[0] as HookSubscription)), handler };
}

/** @param registry - 订阅注册表 @param dispatcher - 订阅调度器 @param recorder - 统一观测记录器 @returns 已安装的 plugin 描述 @author lvdaxianer@yeah.net @date 2026-10-17 */
export function installSystemLoggingPlugin(registry: SubscriptionRegistry, dispatcher: SubscriptionDispatcher, recorder: ObservabilityRecorder): SystemLoggingPlugin {
  const plugin = createSystemLoggingPlugin(recorder);
  if (!validatePluginManifest(plugin.manifest).ok) throw new TypeError('system logging manifest invalid');
  dispatcher.registerHandler('iar.observability.log.write', plugin.handler);
  plugin.subscriptions.forEach((subscription) => registry.register(subscription));
  return plugin;
}

/** @param value - 未知 JSON 对象 @returns 是否为可读对象 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
