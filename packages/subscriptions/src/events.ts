/**
 * 维护 Runtime 所拥有的订阅事件字典，区分精确事件和订阅通配模式。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
const KNOWN_EVENT_NAMES = [
  'semantic.extract.before', 'semantic.extracted', 'function.route.before',
  'function.selected', 'plugin.select.before', 'plugin.selected',
  'policy.evaluate.before', 'policy.evaluated', 'decision.created',
  'input.received', 'action.before', 'action.started', 'action.completed',
  'action.succeeded', 'action.failed', 'workflow.resume.before',
  'workflow.resumed', 'workflow.started', 'workflow.transitioned',
  'workflow.completed', 'workflow.failed', 'confirmation.requested',
  'confirmation.required', 'confirmation.received', 'confirmation.accepted',
  'confirmation.rejected', 'context.compact.before', 'context.compacted',
  'context.compaction_failed', 'run.created', 'run.completed', 'run.failed',
  'plugin.discovered', 'plugin.validated', 'plugin.installed', 'plugin.enabled',
  'plugin.draining', 'plugin.disabled', 'plugin.unloaded', 'plugin.rejected'
] as const;

const KNOWN_EVENT_PATTERNS = [
  ...KNOWN_EVENT_NAMES,
  'run.*', 'workflow.*', 'action.*', 'confirmation.*', 'context.*'
] as const;

/**
 * 判断事件是否属于 Runtime 管理的精确事件字典。
 *
 * @param eventName - 待判断事件名
 * @returns 是否为可发布事件
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function isKnownEventName(eventName: string): boolean {
  return KNOWN_EVENT_NAMES.includes(eventName as (typeof KNOWN_EVENT_NAMES)[number]);
}

/**
 * 判断订阅声明是否为已知精确事件或通配模式。
 *
 * @param eventPattern - 订阅声明中的事件名或模式
 * @returns 是否可以注册
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function isKnownSubscriptionEvent(eventPattern: string): boolean {
  return KNOWN_EVENT_PATTERNS.includes(eventPattern as (typeof KNOWN_EVENT_PATTERNS)[number]);
}
