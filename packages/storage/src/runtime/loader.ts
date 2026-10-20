/**
 * 按显式配置加载内置或外部会话持久化 Provider。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
import {
  validatePersistenceProviderManifest,
  type PersistenceProviderModule,
  type PersistenceProviderOptions,
  type SessionPersistenceProvider
} from '../spi/types.js';
import { PersistenceProviderRegistry } from './registry.js';

/** Provider 加载配置；外部实现必须显式声明模块入口。 */
export type PersistenceProviderConfig = {
  /** 要加载的 Manifest providerId。 */
  provider: string;
  /** 外部 npm 包或模块入口；内置 Provider 不需要配置。 */
  module?: string;
  /** 传给 Provider 工厂和 open 的 JSON 配置。 */
  options?: PersistenceProviderOptions;
};

/** Provider 加载失败时使用的稳定错误。 */
export class PersistenceProviderLoadError extends Error {
  /** @param code - 稳定错误码 @param message - 不包含密钥的诊断信息 @param cause - 原始异常，仅供内部保留 */
  public constructor(
    public readonly code: 'provider_config_invalid' | 'provider_unavailable' | 'provider_module_invalid' | 'provider_api_unsupported' | 'provider_factory_failed' | 'provider_open_failed',
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'PersistenceProviderLoadError';
  }
}

/** 动态导入函数类型，便于契约测试注入而不访问网络。 */
export type PersistenceProviderImporter = (specifier: string) => Promise<unknown>;

/**
 * 解析 Provider、校验 SPI 版本、创建实例并完成异步初始化。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
export class PersistenceProviderLoader {
  /** @param registry - 内置 Provider 注册表 @param importer - 外部模块动态加载器 */
  public constructor(
    private readonly registry: PersistenceProviderRegistry,
    private readonly importer: PersistenceProviderImporter = (specifier) => import(specifier)
  ) {}

  /** 加载配置指定的 Provider，并保证返回对象已经 open。 */
  public async load(config: PersistenceProviderConfig): Promise<SessionPersistenceProvider> {
    if (!isValidProviderId(config?.provider)) throw new PersistenceProviderLoadError('provider_config_invalid', 'Provider 标识无效');
    const module = this.registry.resolve(config.provider) ?? await this.loadExternal(config);
    const manifest = validateModuleManifest(module, config.provider);
    let provider: SessionPersistenceProvider;
    try {
      provider = await module.createProvider(config.options);
    } catch (error) {
      throw new PersistenceProviderLoadError('provider_factory_failed', 'Provider 工厂创建失败', error);
    }
    if (!provider || provider.manifest?.providerId !== manifest.providerId || !hasProviderMethods(provider)) {
      throw new PersistenceProviderLoadError('provider_module_invalid', 'Provider 实例不符合 SPI');
    }
    try {
      await provider.open(config.options);
    } catch (error) {
      try { await provider.close(); } catch { /* 初始化失败时尽力释放资源。 */ }
      throw new PersistenceProviderLoadError('provider_open_failed', 'Provider 初始化失败', error);
    }
    return provider;
  }

  /** 只有配置明确给出模块入口时才尝试外部加载，禁止静默回退。 */
  private async loadExternal(config: PersistenceProviderConfig): Promise<PersistenceProviderModule> {
    if (!config.module) throw new PersistenceProviderLoadError('provider_unavailable', `Provider 未注册: ${config.provider}`);
    let imported: unknown;
    try {
      imported = await this.importer(config.module);
    } catch (error) {
      throw new PersistenceProviderLoadError('provider_unavailable', `Provider 模块不可用: ${config.provider}`, error);
    }
    const candidate = isRecord(imported) && isRecord(imported.default) ? imported.default : imported;
    if (!isRecord(candidate) || typeof candidate.createProvider !== 'function') throw new PersistenceProviderLoadError('provider_module_invalid', '外部 Provider 模块导出无效');
    return candidate as unknown as PersistenceProviderModule;
  }
}

/** 检查 Provider 的完整方法集合，避免半实现对象进入运行时。 */
function hasProviderMethods(provider: SessionPersistenceProvider): boolean {
  return ['open', 'appendMessage', 'appendEvent', 'saveSnapshot', 'loadSnapshot', 'listEvents', 'listMessages', 'flush', 'close'].every((name) => typeof provider[name as keyof SessionPersistenceProvider] === 'function');
}

/** 校验模块 Manifest，并要求配置标识与模块标识一致。 */
function validateModuleManifest(module: PersistenceProviderModule, providerId: string): PersistenceProviderModule['manifest'] {
  try {
    const manifest = validatePersistenceProviderManifest(module.manifest);
    if (manifest.providerId !== providerId) throw new PersistenceProviderLoadError('provider_api_unsupported', 'Provider 标识与配置不一致');
    if (typeof module.createProvider !== 'function') throw new PersistenceProviderLoadError('provider_module_invalid', 'Provider 工厂无效');
    return manifest;
  } catch (error) {
    if (error instanceof PersistenceProviderLoadError) throw error;
    throw new PersistenceProviderLoadError('provider_api_unsupported', 'Provider SPI 版本不支持', error);
  }
}

/** 判断值是否为普通记录。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 判断 Provider 标识是否满足动态加载边界。 */
function isValidProviderId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}
