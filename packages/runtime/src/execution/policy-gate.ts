/**
 * 实现本地 Policy Gate、confirmation scope hash 和 fail-closed 能力校验。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { createHash } from 'node:crypto';
import { validateContract, type ActionDefinition, type ConfirmationState, type JsonValue } from '@iar/contracts';
import type { PolicyRequest, PolicyResult } from './types.js';

/**
 * 计算绑定 Action 全部关键字段的确定性 scope hash。
 * @param action - 待确认的完整 Action
 * @returns 带算法前缀的 sha256 scope hash
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function confirmationScopeHash(action: ActionDefinition): string {
  const scope = { actionId: action.actionId, runId: action.runId, functionId: action.functionId, pluginId: action.pluginId, idempotencyKey: action.idempotencyKey, input: action.input, riskLevel: action.riskLevel, confirmationRequired: action.confirmationRequired };
  return `sha256:${createHash('sha256').update(canonicalJson(scope)).digest('hex')}`;
}

/**
 * 本地策略门禁，永远不把拒绝降级为可执行结果。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class PolicyGate {
  /**
   * 检查授权、能力和高风险 Action confirmation scope。
   * @param input - Action、能力集合和上游授权状态
   * @param confirmation - 当前 Workflow confirmation 状态
   * @returns 允许执行的 scope hash 或稳定拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public evaluate(input: PolicyRequest, confirmation: ConfirmationState): PolicyResult {
    // 外部 Action、能力和授权字段必须先通过运行时边界校验。
    if (!validPolicyInput(input) || !validConfirmation(confirmation)) return { ok: false, reasonCode: 'policy_input_invalid' };
    // 没有明确授权时直接 fail-closed。
    if (!input.authorized) return { ok: false, reasonCode: 'policy_unauthorized' };
    // 当前授权能力必须覆盖规则要求的全部能力。
    if (!hasCapabilities(input.requiredCapabilities, input.grantedCapabilities)) return { ok: false, reasonCode: 'policy_capability_missing' };
    const scopeHash = confirmationScopeHash(input.action);
    // 高风险或显式确认动作必须携带当前 Action 的确认范围。
    if (requiresConfirmation(input.action) && confirmation.state !== 'confirmed') return { ok: false, reasonCode: 'confirmation_required' };
    // 确认不能跨 Action、Plugin、参数或风险等级复用。
    if (requiresConfirmation(input.action) && confirmation.scopeHash !== scopeHash) return { ok: false, reasonCode: 'confirmation_scope_mismatch' };
    return { ok: true, scopeHash };
  }
}

/**
 * 判断能力集合是否覆盖所需能力。
 * @param required - 策略要求的能力
 * @param granted - 当前已授予的能力
 * @returns 是否全部满足
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function hasCapabilities(required: readonly string[], granted: readonly string[]): boolean {
  return required.every((capability) => granted.includes(capability));
}

/**
 * 判断 Action 是否必须经过 confirmation。
 * @param action - 待执行 Action
 * @returns 是否需要确认
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function requiresConfirmation(action: ActionDefinition): boolean {
  return action.confirmationRequired || action.riskLevel === 'high' || action.riskLevel === 'critical';
}

/**
 * 校验 Policy 输入不会把 malformed Action 送入 hash 或 executor。
 * @param input - 未信任的策略输入
 * @returns 输入是否满足运行时类型和公共 Action Schema
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validPolicyInput(input: PolicyRequest): boolean {
  if (!isRecord(input)) return false;
  const action = validateContract('action', input?.action);
  return action.ok && typeof input.authorized === 'boolean' && validStringArray(input.requiredCapabilities) && validStringArray(input.grantedCapabilities);
}

/**
 * 校验 confirmation 只包含公共状态和可选字符串字段。
 * @param confirmation - 当前 Workflow confirmation
 * @returns confirmation 是否可安全消费
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validConfirmation(confirmation: ConfirmationState): boolean {
  const states = new Set(['not_required', 'required', 'confirmed', 'rejected']);
  return states.has(confirmation?.state) && (confirmation.scopeHash === undefined || typeof confirmation.scopeHash === 'string') && (confirmation.confirmedAt === undefined || typeof confirmation.confirmedAt === 'string');
}

/**
 * 校验能力列表是有限且非空字符串集合。
 * @param values - 未信任的能力数组
 * @returns 是否可进入能力比较
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validStringArray(values: unknown): values is readonly string[] {
  return Array.isArray(values) && values.every((value) => typeof value === 'string' && value.length > 0) && new Set(values).size === values.length;
}

/**
 * 判断输入是否为普通对象。
 * @param value - 待判断值
 * @returns 是否为非数组对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 以排序后的对象键生成稳定 JSON 文本。
 * @param value - JSON-safe 输入
 * @returns 与对象插入顺序无关的 JSON 文本
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function canonicalJson(value: JsonValue | Record<string, unknown>): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value) ?? 'null';
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item as JsonValue)}`).join(',')}}`;
}
