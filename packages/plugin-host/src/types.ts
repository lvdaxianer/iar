/**
 * 定义 PluginHost 的注册记录、状态和返回值类型。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { ContractErrorResult, EventEnvelope, PluginManifest } from '@iar/contracts';
import type { PluginHandler, PluginRegistration } from '@iar/plugin-sdk';

/**
 * 插件注册表支持的生命周期状态。
 *
 * discovered/validated 是安装事务中的瞬态事件状态；
 * installed 之后的状态才会保留在当前注册表中；
 * unloaded 表示当前能力已撤销且不再出现在注册表中。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export type PluginState = 'discovered' | 'validated' | 'installed' | 'enabled' | 'draining' | 'disabled' | 'unloaded';

/**
 * 注册表中的当前插件记录，从安装成功后的 installed 状态开始持久存在。
 *
 * @property manifest - 通过契约校验且已深拷贝的插件声明
 * @property state - 当前可路由生命周期状态
 * @property handler - 可选的 SDK 执行处理器
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export type PluginRecord = {
  manifest: PluginManifest;
  state: Exclude<PluginState, 'unloaded'>;
  handler?: PluginHandler;
};

/**
 * PluginHost 接受的安装输入，可直接传 Manifest 或带 Handler 的注册对象。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export type PluginInstallInput = PluginManifest | PluginRegistration;

/**
 * 创建 PluginHost 时提供的静态 Function 边界。
 *
 * @property functionIds - 当前宿主允许插件归属的 Function 标识
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export type PluginHostOptions = {
  functionIds: Iterable<string>;
};

/**
 * PluginHost 的成功或稳定错误结果。
 *
 * @template T - 成功分支携带的值类型
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export type PluginHostResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ContractErrorResult };

/**
 * PluginHost 构造生命周期事件所需的最小信息。
 *
 * @property eventName - 版本化插件事件名称
 * @property pluginId - 事件所属插件
 * @property functionId - 业务插件的 Function 归属
 * @property from - 可选前置状态
 * @property to - 可选目标状态
 * @property reasonCode - 可选拒绝错误码
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export type PluginEventInput = {
  eventName: Extract<EventEnvelope['eventName'], `plugin.${string}`>;
  pluginId: string;
  functionId?: string;
  from?: PluginState;
  to?: PluginState;
  reasonCode?: string;
};
