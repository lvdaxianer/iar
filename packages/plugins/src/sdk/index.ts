/**
 * 提供插件实现与 IAR Host 之间的最小 SDK 边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { JsonValue, PluginManifest } from '@iar/contracts';

/**
 * 插件处理器可返回的执行结果。
 *
 * output 必须保持 JSON 可序列化；status 决定 Host 是否记录成功或失败；
 * errorCode 用于失败路径的稳定审计和后续重试分类。
 *
 * @property output - 插件执行结果
 * @property status - 执行成功或失败
 * @property errorCode - 可选的稳定插件错误码
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export type PluginHandlerResult = {
  output: JsonValue;
  status: 'succeeded' | 'failed';
  errorCode?: string;
};

/**
 * 插件执行上下文，禁止通过上下文修改注册表。
 *
 * @property pluginId - 当前执行插件
 * @property functionId - 可选的业务 Function 归属
 * @property runId - 当前 IAR Run 标识
 * @property correlationId - 当前调用关联标识
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export type PluginHandlerContext = {
  pluginId: string;
  functionId?: string;
  runId: string;
  correlationId: string;
};

/**
 * 插件 Handler 的统一调用签名。
 *
 * Handler 只能接收 JSON 输入和只读执行上下文；
 * 注册表和能力边界仍由 PluginHost 管理。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export type PluginHandler = (
  input: JsonValue,
  context: PluginHandlerContext
) => Promise<PluginHandlerResult>;

/**
 * Host 注册的插件实现及其可选 Handler。
 *
 * Manifest 负责声明边界，Handler 负责提供实现；
 * Host 必须先验证 Manifest，再保存 Handler 引用。
 *
 * @property manifest - 待安装的插件声明
 * @property handler - 可选的执行实现
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export type PluginRegistration = {
  manifest: PluginManifest;
  handler?: PluginHandler;
};
