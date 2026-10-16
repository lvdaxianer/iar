/**
 * 提供 durable Workflow 的显式准入判定。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { DurableAdmissionDecision, DurableRequirementReason, DurableWorkflowRequirement } from './types.js';

/** durable 准入原因的固定顺序，保证审计输出确定。 */
const DURABLE_REASONS: readonly DurableRequirementReason[] = ['timer', 'cross_service', 'compensation'];

/**
 * 判断 Workflow 是否具备进入 durable adapter 的明确理由。
 * @param requirement - 未信任的 durable 需求声明
 * @returns 稳定的准入或拒绝结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function evaluateDurableAdmission(requirement: unknown): DurableAdmissionDecision {
  try {
    return evaluateAdmission(requirement);
  } catch {
    // 恶意 getter 或 revoked Proxy 不得把原始异常泄露给调用方。
    return { admitted: false, reasonCode: 'durable_requirement_invalid' };
  }
}

/**
 * 执行不带异常边界的准入字段判定。
 * @param requirement - 未信任的 durable 需求声明
 * @returns 稳定的准入或拒绝结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function evaluateAdmission(requirement: unknown): DurableAdmissionDecision {
  // 非对象或缺少稳定字段时，拒绝进入 durable adapter。
  if (!isRequirementRecord(requirement)) return { admitted: false, reasonCode: 'durable_requirement_invalid' };
  // 没有明确长期运行理由时，短动作继续使用 LocalWorkflow。
  if (requirement.reasons.length === 0) return { admitted: false, reasonCode: 'durable_requirement_missing' };
  const reasons = normalizeReasons(requirement.reasons);
  // 未知理由不得扩大 durable 准入白名单。
  if (!reasons) return { admitted: false, reasonCode: 'durable_requirement_invalid' };
  return { admitted: true, workflowId: requirement.workflowId, reasons };
}

/**
 * 校验需求声明外围字段，避免从未信任输入读取不稳定结构。
 * @param value - 未信任的输入
 * @returns 是否具备可继续校验的字段形状
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isRequirementRecord(value: unknown): value is DurableWorkflowRequirement {
  return isRecord(value)
    && typeof value.workflowId === 'string'
    && value.workflowId.length > 0
    && Array.isArray(value.reasons)
    && (value.rationale === undefined || typeof value.rationale === 'string');
}

/**
 * 去重并按固定顺序整理准入原因。
 * @param reasons - 未信任的原因列表
 * @returns 确定顺序的原因列表或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function normalizeReasons(reasons: readonly unknown[]): readonly DurableRequirementReason[] | undefined {
  // 未知理由必须拒绝，不能通过类型断言扩大 durable 能力。
  if (!reasons.every((reason) => DURABLE_REASONS.includes(reason as DurableRequirementReason))) return undefined;
  return DURABLE_REASONS.filter((reason) => reasons.includes(reason));
}

/**
 * 判断值是否为非数组对象。
 * @param value - 待判断值
 * @returns 是否为普通对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
