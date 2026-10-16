/**
 * 定义 IAR 对外契约使用的稳定版本标识。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */

/** IAR 当前兼容的公共 API 版本。 */
export const IAR_API_VERSION = 'iar.dev/v1' as const;

/** 各类公共对象的 Schema 版本。 */
export const SCHEMA_VERSIONS = {
  // Action 版本覆盖请求和结果载荷。
  action: 'iar.action/v1',
  // BehaviorContext 版本覆盖事件投影状态。
  behaviorContext: 'iar.behavior-context/v1',
  decision: 'iar.decision/v1',
  error: 'iar.error/v1',
  event: 'iar.event/v1',
  function: 'iar.function/v1',
  pluginManifest: 'iar.plugin-manifest/v1',
  rule: 'iar.rule/v1',
  workflow: 'iar.workflow/v1'
} as const;

/** 表示 IAR 支持的公共 API 版本类型。 */
export type IarApiVersion = typeof IAR_API_VERSION;

/** 表示所有公共 Schema 版本的联合类型。 */
export type SchemaVersion = (typeof SCHEMA_VERSIONS)[keyof typeof SCHEMA_VERSIONS];
