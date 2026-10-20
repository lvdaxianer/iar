/**
 * 提供 Plugin 包与 Function 实现之间的最小运行时 SDK 边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
import type { FunctionDefinition, JsonValue, PluginManifest, PluginOperation } from '@iar/contracts';

/**
 * Function Handler 的执行结果。
 *
 * @property output - 必须可以安全序列化的 JSON 输出
 * @property status - 执行成功或失败
 * @property errorCode - 失败路径使用的稳定错误码
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
export type FunctionHandlerResult = {
  output: JsonValue;
  status: 'succeeded' | 'failed';
  errorCode?: string;
};

/**
 * Function Handler 的只读执行上下文。
 *
 * @property pluginId - 当前 Plugin 包标识
 * @property functionId - 当前 Function 标识
 * @property runId - 当前 IAR Run 标识
 * @property correlationId - 当前调用关联标识
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
export type FunctionHandlerContext = {
  pluginId: string;
  functionId: string;
  runId: string;
  correlationId: string;
};

/**
 * Function 的统一执行签名。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
export type FunctionHandler = (
  input: JsonValue,
  context: FunctionHandlerContext
) => Promise<FunctionHandlerResult>;

/** 一个 Plugin 包内的 Function 注册项。 */
export type FunctionRegistration = {
  definition: FunctionDefinition;
  operations: readonly PluginOperation[];
  handler: FunctionHandler;
};

/** defineFunction 接收的 Function 注册输入。 */
export type FunctionRegistrationInput = FunctionRegistration;

/** 一个 Plugin 包的完整本地运行时注册形状。 */
export type PluginPackage = {
  manifest: PluginManifest;
  functions: readonly FunctionRegistration[];
};

/** definePlugin 接收的 Plugin 包输入。 */
export type PluginPackageInput = PluginPackage;
