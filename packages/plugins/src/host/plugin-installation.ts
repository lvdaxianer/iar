/**
 * 提供插件安装输入的归一化、校验和记录构造。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { ERROR_CODES, SCHEMA_VERSIONS, validatePluginManifest, type ContractErrorResult, type PluginManifest } from '@iar/contracts';
import type { PluginHandler } from '../sdk/index.js';
import type { PluginHostResult, PluginRecord } from './types.js';

/** 单次安装允许的最大插件数量，避免无界输入耗尽宿主资源。 */
export const MAX_INSTALL_BATCH_SIZE = 1000;

/** 安装前校验阶段保留的 Manifest 和 Handler。 */
export type InstallPreparation = {
  manifests: PluginManifest[];
  handlers: ReadonlyMap<string, PluginHandler | undefined>;
};

/**
 * 判断未知值是否为可读取字段的对象。
 *
 * @param value - 待判断的未知值
 * @returns 是否为非数组对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 从未知输入中读取可用于拒绝事件的插件标识。
 *
 * @param input - Manifest、Registration 或其他未知输入
 * @returns 可写入拒绝事件的插件标识
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function pluginIdOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!isRecord(input)) return 'unknown';
  if (typeof input.pluginId === 'string') return input.pluginId;
  return isRecord(input.manifest) && typeof input.manifest.pluginId === 'string' ? input.manifest.pluginId : 'unknown';
}

/**
 * 构造安装阶段的稳定错误。
 *
 * @param code - 稳定错误码
 * @param message - 面向调用方的错误消息
 * @param details - 可审计错误详情
 * @returns 结构化错误结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function installationError(code: typeof ERROR_CODES.CONTRACT_VALIDATION_FAILED | typeof ERROR_CODES.PLUGIN_DUPLICATE_ID | typeof ERROR_CODES.PLUGIN_FUNCTION_NOT_FOUND | typeof ERROR_CODES.PLUGIN_INSTALL_BATCH_TOO_LARGE, message: string, details: Record<string, unknown> = {}): ContractErrorResult {
  return { schemaVersion: SCHEMA_VERSIONS.error, code, message, retryable: false, details };
}

/**
 * 归一化 Manifest 或 SDK Registration 输入。
 *
 * @param input - Manifest 或 Registration 输入
 * @returns 待校验 Manifest 和可选 Handler，格式非法时返回 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function normalizeInstallInput(input: unknown): { manifestInput: unknown; handler?: PluginHandler } | undefined {
  if (!isRecord(input) || !Object.hasOwn(input, 'manifest')) return { manifestInput: input };
  if (!isRecord(input.manifest) || (input.handler !== undefined && typeof input.handler !== 'function')) return undefined;
  const normalized: { manifestInput: unknown; handler?: PluginHandler } = { manifestInput: input.manifest };
  if (typeof input.handler === 'function') normalized.handler = input.handler as PluginHandler;
  return normalized;
}

/**
 * 校验所有安装输入但不触碰当前注册表。
 *
 * @param inputs - Manifest 或 SDK Registration 输入
 * @returns 原子提交所需的校验结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function prepareInstall(inputs: unknown[]): PluginHostResult<InstallPreparation> {
  // 批量安装必须先受资源边界保护，再创建校验中间结构。
  if (inputs.length > MAX_INSTALL_BATCH_SIZE) {
    return {
      ok: false,
      error: installationError(ERROR_CODES.PLUGIN_INSTALL_BATCH_TOO_LARGE, '批量安装数量超过上限', {
        maxBatchSize: MAX_INSTALL_BATCH_SIZE
      })
    };
  }
  const manifests: PluginManifest[] = [];
  const handlers = new Map<string, PluginHandler | undefined>();
  for (const input of inputs) {
    const normalized = normalizeInstallInput(input);
    // Registration 的 Handler 不是函数时，拒绝整个安装事务。
    if (!normalized) {
      return { ok: false, error: installationError(ERROR_CODES.CONTRACT_VALIDATION_FAILED, '插件 Handler 必须是函数', { pluginId: pluginIdOf(input) }) };
    }
    const result = validatePluginManifest(normalized.manifestInput);
    // Manifest 契约失败时，不向注册表写入任何记录。
    if (!result.ok) {
      return { ok: false, error: { ...result.error, details: { ...result.error.details, pluginId: pluginIdOf(input) } } };
    }
    manifests.push(result.value);
    handlers.set(result.value.pluginId, normalized.handler);
  }
  return { ok: true, value: { manifests, handlers } };
}

/**
 * 校验已排序的 Manifest 不会破坏当前注册表。
 *
 * @param manifests - 已完成契约和依赖排序的 Manifest
 * @param existingIds - 当前注册表中的插件标识
 * @param functionIds - 宿主已注册的 Function 标识
 * @returns 校验后的 Manifest 或稳定错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function validateInstallSet(manifests: PluginManifest[], existingIds: ReadonlySet<string>, functionIds: ReadonlySet<string>): PluginHostResult<PluginManifest[]> {
  for (const manifest of manifests) {
    // 已安装标识冲突必须保持当前能力不变。
    if (existingIds.has(manifest.pluginId)) {
      return { ok: false, error: installationError(ERROR_CODES.PLUGIN_DUPLICATE_ID, '插件已安装', { pluginId: manifest.pluginId }) };
    }
    // 业务插件只能引用宿主已注册的 Function。
    if (manifest.pluginKind === 'function' && !functionIds.has(manifest.functionId)) {
      return {
        ok: false,
        error: installationError(ERROR_CODES.PLUGIN_FUNCTION_NOT_FOUND, 'Function 不存在', {
          pluginId: manifest.pluginId,
          functionId: manifest.functionId
        })
      };
    }
  }
  return { ok: true, value: manifests };
}

/**
 * 创建与调用方输入隔离的安装记录。
 *
 * @param manifest - 通过契约校验的 Manifest
 * @param handler - 可选插件 Handler
 * @returns 可写入当前注册表的记录
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function createRecord(manifest: PluginManifest, handler?: PluginHandler): PluginRecord {
  const record: PluginRecord = { manifest: structuredClone(manifest), state: 'installed' };
  if (handler) record.handler = handler;
  return record;
}
