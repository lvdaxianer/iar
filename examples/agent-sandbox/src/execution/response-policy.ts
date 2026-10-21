/**
 * 在 sandbox 的已校验 Handler 边界执行 Operation-aware 回复策略。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
import type { FunctionResponse, PluginOperation } from '@iar/contracts';

/** Operation-aware 响应策略校验结果。 */
export type ResponsePolicyResult =
  | { ok: true; operationKind: PluginOperation['kind'] }
  | { ok: false; code: 'function.response_policy_violation'; message: string };

/**
 * 校验 Handler 响应模式是否符合运行时选中的 Operation。
 * read Operation 必须交给 Response Model；action Operation 才允许 direct/none。
 *
 * @param input - 已通过 Function 输入 Schema 的输入
 * @param operations - 已通过 SDK 校验的 Operation 目录
 * @param response - 已通过 FunctionResponse Schema 的响应信封
 * @returns Operation kind 或稳定拒绝原因
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
export function validateResponsePolicy(input: unknown, operations: readonly PluginOperation[], response: FunctionResponse): ResponsePolicyResult {
  const operation = resolveOperation(input, operations);
  if (!operation) return { ok: false, code: 'function.response_policy_violation', message: 'Function 输入没有对应的 Operation。' };
  if (operation.kind === 'read' && response.mode !== 'model') return { ok: false, code: 'function.response_policy_violation', message: 'read Operation 的结果必须交给 Response Model。' };
  return { ok: true, operationKind: operation.kind };
}

/** 从固定输入中解析唯一的 Operation，未知值按失败关闭。 */
function resolveOperation(input: unknown, operations: readonly PluginOperation[]): PluginOperation | undefined {
  const record = isRecord(input) ? input : {};
  const name = typeof record.operation === 'string' && record.operation.length > 0 ? record.operation : undefined;
  if (name !== undefined) return operations.find((item) => item.name === name);
  return operations.length === 1 ? operations[0] : undefined;
}

/** 读取非数组对象，拒绝原型和数组输入。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
