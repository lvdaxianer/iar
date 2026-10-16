/**
 * 为 Service API 固定请求的租户存储范围。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { StorageValidationError } from '../../../storage/src/index.js';
import type { TenantAuthorizer, TenantRequestContext, TenantStorage, TenantStorageFactory } from './types.js';

/** 只允许通过租户 ID 创建隔离存储门面的 Service adapter。 */
export class TenantStorageService {
  /**
   * 接收部署层提供的存储工厂，不持有 SQL 细节。
   *
   * @param factory - 创建租户绑定存储的工厂
   * @param authorize - 根据 actor 和 tenant 执行授权的回调
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(private readonly factory: TenantStorageFactory, private readonly authorize: TenantAuthorizer) {}

  /**
   * 为已通过授权的请求上下文创建 tenant-bound 存储。
   *
   * @param context - 已认证请求的租户和 actor 上下文
   * @returns 绑定到单一租户的存储组合
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public forTenant(context: TenantRequestContext): TenantStorage {
    assertRequestContext(context);
    if (!isAuthorized(this.authorize, context)) throw new StorageValidationError('tenant authorization failed');
    const storage = this.factory(context.tenantId);
    if (storage.tenantId !== context.tenantId) throw new StorageValidationError('存储工厂返回了错误的 tenantId');
    return storage;
  }
}

/**
 * Service 入口拒绝不完整请求，避免未认证上下文切换租户。
 *
 * @param context - 待校验的租户请求上下文
 * @returns 无返回值；无效上下文抛出稳定校验错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertRequestContext(context: TenantRequestContext): void {
  if (typeof context !== 'object' || context === null || !isIdentifier(context.tenantId, 128) || !isIdentifier(context.actorId, 256)) {
    throw new StorageValidationError('tenant request context 无效');
  }
}

/**
 * 将授权器异常转换成 fail-closed 的稳定授权失败。
 *
 * @param authorize - 授权判断回调
 * @param context - 当前请求上下文
 * @returns 是否通过授权
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isAuthorized(authorize: TenantAuthorizer, context: TenantRequestContext): boolean {
  try {
    return authorize(context);
  } catch {
    return false;
  }
}

/**
 * 复用 tenant/actor 的长度和控制字符边界，拒绝不可审计标识。
 *
 * @param value - 待检查的标识
 * @param maxLength - 允许的最大长度
 * @returns 是否为安全可审计标识
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isIdentifier(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value);
}
