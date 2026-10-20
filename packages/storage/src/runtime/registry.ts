/**
 * 管理已注册的会话持久化 Provider，隔离运行时与具体存储实现。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
import {
  validatePersistenceProviderManifest,
  type PersistenceProviderManifest,
  type PersistenceProviderModule
} from '../spi/types.js';

/** Provider 注册失败时使用的稳定错误。 */
export class PersistenceProviderRegistryError extends Error {
  /** @param code - 稳定错误码 @param message - 不包含敏感配置的诊断信息 */
  public constructor(public readonly code: 'provider_duplicate' | 'provider_invalid' | 'provider_not_found', message: string) {
    super(message);
    this.name = 'PersistenceProviderRegistryError';
  }
}

/**
 * 保存经过 SPI 校验的 Provider 模块，并按 providerId 提供精确查找。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
export class PersistenceProviderRegistry {
  private readonly modules = new Map<string, PersistenceProviderModule>();

  /** @param modules - 启动时要注册的内置 Provider */
  public constructor(modules: readonly PersistenceProviderModule[] = []) {
    for (const module of modules) this.register(module);
  }

  /** 注册一个 Provider 模块，重复标识直接拒绝覆盖。 */
  public register(module: PersistenceProviderModule): void {
    if (!module || typeof module !== 'object') throw new PersistenceProviderRegistryError('provider_invalid', 'Provider 模块无效');
    let manifest: PersistenceProviderManifest;
    try {
      manifest = validatePersistenceProviderManifest(module?.manifest);
    } catch (error) {
      throw new PersistenceProviderRegistryError('provider_invalid', error instanceof Error ? error.message : 'Provider Manifest 无效');
    }
    if (typeof module.createProvider !== 'function') throw new PersistenceProviderRegistryError('provider_invalid', 'Provider 工厂无效');
    if (this.modules.has(manifest.providerId)) throw new PersistenceProviderRegistryError('provider_duplicate', `Provider 已注册: ${manifest.providerId}`);
    this.modules.set(manifest.providerId, { manifest, createProvider: module.createProvider });
  }

  /** 按稳定标识读取 Provider 模块。 */
  public resolve(providerId: string): PersistenceProviderModule | undefined {
    return this.modules.get(providerId);
  }

  /** 返回稳定排序后的已注册 Manifest，供诊断和管理面使用。 */
  public list(): PersistenceProviderManifest[] {
    return [...this.modules.values()].map((module) => module.manifest).sort((left, right) => left.providerId.localeCompare(right.providerId));
  }
}
