/**
 * durable runtime 的敏感字段脱敏和 Action 结果安全化。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { createHash } from 'node:crypto';
import { type ActionResult, type JsonValue } from '@iar/contracts';
import type { DurableExecuteRequest, DurableStepData } from './types.js';
import type { WorkflowResult, WorkflowRun } from '@iar/workflow';

/**
 * 将 Action 输入替换为不可逆摘要。
 * @param action - 未信任 Action 定义
 * @returns 不含原始 input 的 Action 副本
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function redactAction(action: DurableExecuteRequest['action']): DurableExecuteRequest['action'] {
  return { ...structuredClone(action), input: redactedValue(action.input) };
}

/**
 * 构造不含 executor 和敏感输入的持久请求。
 * @param input - 未信任 durable Action 请求
 * @returns 可持久化的安全请求
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function redactRequest(input: DurableExecuteRequest): DurableExecuteRequest {
  return { ...structuredClone(input), action: redactAction(input.action) };
}

/**
 * 将 step 中可能包含 Action 的数据安全化。
 * @param data - step 数据
 * @returns 脱敏后的 step 数据
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function redactStepData(data: DurableStepData): DurableStepData {
  // execute step 只保留无 executor 的安全请求。
  if (data.kind === 'execute') return { kind: 'execute', request: redactRequest(data.request) };
  // confirmation 仍需保留 Action 身份，但不能保存原始 input。
  if (data.kind === 'confirm') return { kind: 'confirm', input: { ...structuredClone(data.input), action: redactAction(data.input.action) } };
  // 非 Action step 不包含需要特殊处理的敏感字段。
  return structuredClone(data);
}

/**
 * 将运行快照中的 Action 输入安全化。
 * @param run - Workflow 运行态
 * @returns 脱敏后的运行态
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function redactRun(run: WorkflowRun): WorkflowRun {
  const safeRun = structuredClone(run);
  // run 中的当前 Action 与 step/action record 使用同一摘要规则。
  if (safeRun.action) safeRun.action = redactAction(safeRun.action);
  return safeRun;
}

/**
 * 将事件 payload 中的 input/output 替换为稳定摘要。
 * @param payload - 原始事件 payload
 * @returns 安全事件 payload
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function redactPayload(payload: JsonValue): JsonValue {
  // 非对象 payload 不包含约定的敏感 input/output 字段。
  if (!isRecord(payload)) return structuredClone(payload);
  const safe = structuredClone(payload);
  // 事件 payload 只允许稳定摘要进入 durable event history。
  if ('input' in safe) safe.input = redactedValue(safe.input);
  // output 与 input 具有相同的敏感性，不能保留原值。
  if ('output' in safe) safe.output = redactedValue(safe.output);
  return safe;
}

/**
 * 将任意 JSON 值转成不可逆摘要对象。
 * @param value - 原始 JSON 值
 * @returns 不可逆摘要对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function redactedValue(value: JsonValue): JsonValue {
  const digest = createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
  return { redacted: true, digest: `sha256:${digest}` };
}

/**
 * 将 ActionResult output 脱敏后保存，保留状态和错误码语义。
 * @param result - 未信任执行结果
 * @returns 安全持久化结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function redactOutcome(result: WorkflowResult<ActionResult>): WorkflowResult<ActionResult> {
  // 失败结果只保留稳定 reasonCode，不复制底层异常对象。
  if (!result.ok) return structuredClone(result);
  const safe = structuredClone(result.value);
  // 成功输出同样可能包含业务秘密，必须摘要化后再持久化。
  if (safe.output !== undefined) safe.output = redactedValue(safe.output);
  return { ok: true, value: safe };
}

/**
 * 构造可供 LocalWorkflow 重放的失败 ActionResult。
 * @param action - 持久 Action 定义
 * @param reasonCode - 稳定失败码
 * @returns 失败结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function failedAction(action: DurableExecuteRequest['action'], reasonCode: string): ActionResult {
  return { schemaVersion: action.schemaVersion, actionId: action.actionId, status: 'failed', errorCode: reasonCode };
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
