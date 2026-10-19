/**
 * 创建 sandbox 使用的会话持久化 Provider。
 *
 * 默认使用内置 SQLite；宿主可通过环境变量选择外部 SPI 模块，sandbox 不关心
 * Provider 的具体存储实现，只负责传递 JSON 配置和管理生命周期。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { JsonValue } from '@iar/contracts';
import type { PersistenceProviderOptions, SessionPersistenceProvider } from '@iar/persistence-spi';
import { PersistenceProviderLoader, PersistenceProviderRegistry } from '@iar/persistence-runtime';
import { sqlitePersistenceProviderModule } from '@iar/persistence-sqlite';

const DEFAULT_SQLITE_PATH = join(process.cwd(), 'data', 'iar-sandbox.sqlite');

/** 按环境变量加载并初始化 Provider；所有失败都在服务启动阶段暴露。 */
export async function loadSandboxPersistenceProvider(options: { sqlitePath?: string } = {}): Promise<SessionPersistenceProvider> {
  const provider = process.env.IAR_PERSISTENCE_PROVIDER?.trim() || 'sqlite';
  const module = process.env.IAR_PERSISTENCE_MODULE?.trim() || undefined;
  const providerOptions = await readProviderOptions(provider, options.sqlitePath);
  const registry = new PersistenceProviderRegistry([sqlitePersistenceProviderModule]);
  const config: { provider: string; module?: string; options?: PersistenceProviderOptions } = { provider, ...(module ? { module } : {}), ...(providerOptions === undefined ? {} : { options: providerOptions }) };
  return new PersistenceProviderLoader(registry).load(config);
}

/** 解析 Provider 的 JSON 配置，并为内置 SQLite 补齐可恢复的默认文件路径。 */
async function readProviderOptions(provider: string, sqlitePath?: string): Promise<Record<string, JsonValue> | undefined> {
  const raw = process.env.IAR_PERSISTENCE_OPTIONS_JSON?.trim();
  let options: Record<string, JsonValue> = {};
  if (raw) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (error) { throw new Error('IAR_PERSISTENCE_OPTIONS_JSON 必须是合法 JSON', { cause: error }); }
    if (!isRecord(parsed)) throw new Error('IAR_PERSISTENCE_OPTIONS_JSON 必须是 JSON 对象');
    options = parsed as Record<string, JsonValue>;
  }
  if (provider !== 'sqlite') return raw ? options : undefined;
  const filename = typeof options.filename === 'string' && options.filename.trim().length > 0
    ? options.filename
    : sqlitePath?.trim() || process.env.IAR_SANDBOX_SQLITE_PATH?.trim() || DEFAULT_SQLITE_PATH;
  if (filename !== ':memory:') await mkdir(dirname(filename), { recursive: true });
  return { ...options, filename };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
