/**
 * 定义 Service 层可以暴露的租户绑定存储形状。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { EventStore, RegistryStore, SnapshotStore } from '../../../storage/src/index.js';

/** Service adapter 对外提供的最小租户存储组合。 */
export type TenantStorage = {
  // tenantId 是只读语义字段，具体 store 已在构造时完成租户绑定。
  tenantId: string;
  eventStore: EventStore;
  snapshotStore: SnapshotStore;
  registryStore: RegistryStore;
};

/** 创建租户绑定存储的工厂。 */
export type TenantStorageFactory = (tenantId: string) => TenantStorage;

// 工厂只负责构造，不负责把未经授权的请求转换成租户上下文。

/** 经过认证的 Service 请求上下文，授权器必须校验 actor 与 tenant 关系。 */
export type TenantRequestContext = {
  tenantId: string;
  actorId: string;
};

/** Service adapter 的显式租户授权回调。 */
export type TenantAuthorizer = (context: TenantRequestContext) => boolean;
