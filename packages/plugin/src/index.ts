/**
 * 提供 Plugin > Function > Operation 的插件作者定义入口。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
import {
  ContractValidationError,
  ERROR_CODES,
  validateContract,
  validatePluginManifest,
  type ContractIssue,
  type ErrorCode,
  type PluginManifest,
  type PluginOperation
} from '@iar/contracts';
import type {
  FunctionRegistration,
  FunctionRegistrationInput,
  PluginPackage,
  PluginPackageInput
} from '@iar/plugins';

export type {
  FunctionHandler,
  FunctionHandlerContext,
  FunctionHandlerResult,
  FunctionRegistration,
  FunctionRegistrationInput,
  PluginPackage,
  PluginPackageInput
} from '@iar/plugins';

/**
 * 定义并校验一个 Plugin 包内的 Function。
 *
 * @param input - Function 定义、操作目录和执行 Handler
 * @returns 与输入边界隔离的 Function 注册项
 * @throws {ContractValidationError} Function 契约或操作目录无效时抛出
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
export function defineFunction(input: FunctionRegistrationInput): FunctionRegistration {
  if (!input || !Array.isArray(input.operations)) throw new ContractValidationError('Function Operation 目录必须是数组');
  const definition = validateContract('function', input.definition);
  if (!definition.ok) throw toValidationError(definition.error.code, definition.error.details);
  if (typeof input.handler !== 'function') throw new ContractValidationError('Function Handler 必须是函数');
  const operations = validateOperations(input.operations);
  return {
    definition: structuredClone(definition.value) as FunctionRegistration['definition'],
    operations,
    handler: input.handler
  };
}

/**
 * 定义并校验一个 Plugin 包。
 *
 * @param input - Plugin 包级 Manifest 和嵌套 Function 注册项
 * @returns 可交给 IAR Agent 或 PluginHost 的完整包
 * @throws {ContractValidationError} Plugin 或 Function 边界无效时抛出
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
export function definePlugin(input: PluginPackageInput): PluginPackage {
  if (!input || !Array.isArray(input.functions)) throw new ContractValidationError('Plugin functions 必须是数组');
  const manifestResult = validatePluginManifest(input.manifest);
  if (!manifestResult.ok) throw toValidationError(manifestResult.error.code, manifestResult.error.details);
  const functions = input.functions.map((item) => defineFunction(item));
  validateFunctionOwnership(manifestResult.value, functions);
  return { manifest: structuredClone(manifestResult.value), functions };
}

/**
 * 验证 Plugin 包的 Function 唯一性和能力闭包。
 *
 * @param manifest - 已通过 Manifest 校验的包级声明
 * @param functions - 已通过 Function 校验的注册项
 * @returns 无返回值
 * @throws {ContractValidationError} Function 归属或能力边界无效时抛出
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
function validateFunctionOwnership(manifest: PluginManifest, functions: readonly FunctionRegistration[]): void {
  const ids = functions.map((item) => item.definition.functionId);
  if (new Set(ids).size !== ids.length) throw new ContractValidationError('Plugin 内 Function ID 不能重复', [], ERROR_CODES.PLUGIN_DUPLICATE_ID);
  if (manifest.pluginKind === 'system' && functions.length > 0) throw new ContractValidationError('系统 Plugin 不能注册业务 Function');
  if (manifest.pluginKind === 'business' && functions.length === 0) throw new ContractValidationError('业务 Plugin 必须至少注册一个 Function', [], ERROR_CODES.PLUGIN_FUNCTION_NOT_FOUND);
  const capabilities = new Set(manifest.capabilities);
  const unauthorized = functions.flatMap((item) => item.definition.capabilities.filter((capability) => !capabilities.has(capability)));
  if (unauthorized.length > 0) throw new ContractValidationError('Function 能力必须属于 Plugin 能力集合', [], ERROR_CODES.POLICY_DENIED);
}

/** 校验 Function 的 Operation 目录，避免 SDK 创建带有重复或未知动作的包。 */
function validateOperations(input: readonly PluginOperation[]): PluginOperation[] {
  const names = new Set<string>();
  return input.map((operation) => {
    if (!operation || typeof operation.name !== 'string' || operation.name.length === 0 || typeof operation.description !== 'string' || (operation.kind !== 'read' && operation.kind !== 'action')) {
      throw new ContractValidationError('Function Operation 目录无效');
    }
    if (names.has(operation.name)) throw new ContractValidationError('Function Operation 名称不能重复', [], ERROR_CODES.PLUGIN_DUPLICATE_ID);
    names.add(operation.name);
    return { name: operation.name, kind: operation.kind, description: operation.description };
  });
}

/**
 * 将契约错误转换为稳定的公开异常。
 *
 * @param code - 契约错误码
 * @param details - 字段级校验详情
 * @returns 稳定契约异常
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
function toValidationError(code: ErrorCode, details: Record<string, unknown> | undefined): ContractValidationError {
  const issues = Array.isArray(details?.issues) ? details.issues as ContractIssue[] : [];
  return new ContractValidationError('Plugin 包契约校验失败', issues, code);
}
