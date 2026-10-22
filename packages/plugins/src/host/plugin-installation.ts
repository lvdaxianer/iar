/**
 * 提供 Plugin 包安装输入的归一化、校验和记录构造。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
import {
  ERROR_CODES,
  SCHEMA_VERSIONS,
  validateContract,
  validatePluginManifest,
  type ContractErrorResult,
  type ErrorCode,
  type PluginManifest,
  type PluginOperation
} from '@iar/contracts';
import type { FunctionRegistration, PluginPackage } from '../sdk/index.js';
import { normalizePluginToolName } from './nested-tool-contract.js';
import type { PluginHostResult, PluginFunctionRecord, PluginRecord } from './types.js';

/** 单次安装允许的最大 Plugin 包数量。 */
export const MAX_INSTALL_BATCH_SIZE = 1000;

/** 安装前校验阶段保留的 Plugin 包和 Manifest。 */
export type InstallPreparation = {
  packages: PluginPackage[];
  manifests: PluginManifest[];
};

/** 判断未知值是否是可读取字段的普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读取输入中可用于拒绝事件的 Plugin 标识。 */
export function pluginIdOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!isRecord(input)) return 'unknown';
  if (typeof input.pluginId === 'string') return input.pluginId;
  if (isRecord(input.manifest) && typeof input.manifest.pluginId === 'string') return input.manifest.pluginId;
  return 'unknown';
}

/** 构造安装阶段的稳定错误。 */
function installationError(code: ErrorCode, message: string, details: Record<string, unknown> = {}): ContractErrorResult {
  return { schemaVersion: SCHEMA_VERSIONS.error, code, message, retryable: false, details };
}

/** 归一化 Plugin 包输入，系统 Manifest 才允许没有本地 Function 注册。 */
function normalizePackage(input: unknown): { manifestInput: unknown; functionsInput: unknown } | undefined {
  if (!isRecord(input)) return undefined;
  if (Object.hasOwn(input, 'manifest')) return { manifestInput: input.manifest, functionsInput: input.functions };
  if (input.pluginKind === 'system') return { manifestInput: input, functionsInput: [] };
  return undefined;
}

/** 校验单个 Function 注册项，并隔离可变声明数据。 */
function validateFunctionRegistration(input: unknown, pluginId: string): PluginHostResult<PluginFunctionRecord> {
  if (!isRecord(input) || !isRecord(input.definition) || !Array.isArray(input.operations) || typeof input.handler !== 'function') {
    return { ok: false, error: installationError(ERROR_CODES.CONTRACT_VALIDATION_FAILED, 'Function 注册项无效', { pluginId }) };
  }
  const definition = validateContract('function', input.definition);
  if (!definition.ok) return { ok: false, error: { ...definition.error, details: { ...definition.error.details, pluginId } } };
  const operations = validateOperations(input.operations, pluginId);
  if (!operations.ok) return operations;
  return {
    ok: true,
    value: {
      definition: structuredClone(definition.value) as PluginFunctionRecord['definition'],
      operations: structuredClone(operations.value),
      handler: input.handler as PluginFunctionRecord['handler']
    }
  };
}

/** 校验 Function 的有界操作目录。 */
function validateOperations(input: unknown[], pluginId: string): PluginHostResult<PluginOperation[]> {
  const operations: PluginOperation[] = [];
  const names = new Set<string>();
  for (const item of input) {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.description !== 'string' || (item.kind !== 'read' && item.kind !== 'action')) {
      return { ok: false, error: installationError(ERROR_CODES.CONTRACT_VALIDATION_FAILED, 'Function 操作目录无效', { pluginId }) };
    }
    if (names.has(item.name)) return { ok: false, error: installationError(ERROR_CODES.PLUGIN_DUPLICATE_ID, 'Function 操作名称不能重复', { pluginId, operation: item.name }) };
    names.add(item.name);
    operations.push({ name: item.name, kind: item.kind, description: item.description });
  }
  return { ok: true, value: operations };
}

/** 校验一个完整 Plugin 包并构造宿主内部包记录。 */
function validatePackage(input: unknown): PluginHostResult<PluginPackage> {
  const normalized = normalizePackage(input);
  if (!normalized || !Array.isArray(normalized.functionsInput)) return { ok: false, error: installationError(ERROR_CODES.CONTRACT_VALIDATION_FAILED, 'Plugin 包必须包含 functions 数组', { pluginId: pluginIdOf(input) }) };
  const manifest = validatePluginManifest(normalized.manifestInput);
  if (!manifest.ok) return { ok: false, error: { ...manifest.error, details: { ...manifest.error.details, pluginId: pluginIdOf(input) } } };
  if (manifest.value.pluginKind === 'business' && normalized.functionsInput.length === 0) return { ok: false, error: installationError(ERROR_CODES.PLUGIN_FUNCTION_NOT_FOUND, '业务 Plugin 必须至少注册一个 Function', { pluginId: manifest.value.pluginId }) };
  if (manifest.value.pluginKind === 'system' && normalized.functionsInput.length > 0) return { ok: false, error: installationError(ERROR_CODES.CONTRACT_VALIDATION_FAILED, '系统 Plugin 不能注册业务 Function', { pluginId: manifest.value.pluginId }) };
  const functions: PluginFunctionRecord[] = [];
  for (const item of normalized.functionsInput) {
    const result = validateFunctionRegistration(item, manifest.value.pluginId);
    if (!result.ok) return result;
    functions.push(result.value);
  }
  const ids = functions.map((item) => item.definition.functionId);
  if (new Set(ids).size !== ids.length) return { ok: false, error: installationError(ERROR_CODES.PLUGIN_DUPLICATE_ID, 'Plugin 内 Function ID 不能重复', { pluginId: manifest.value.pluginId }) };
  const capabilities = new Set(manifest.value.capabilities);
  if (functions.some((item) => item.definition.capabilities.some((capability) => !capabilities.has(capability)))) return { ok: false, error: installationError(ERROR_CODES.POLICY_DENIED, 'Function 能力必须属于 Plugin 能力集合', { pluginId: manifest.value.pluginId }) };
  return { ok: true, value: { manifest: structuredClone(manifest.value), functions } };
}

/** 校验全部安装输入但不触碰当前注册表。 */
export function prepareInstall(inputs: unknown[]): PluginHostResult<InstallPreparation> {
  if (inputs.length > MAX_INSTALL_BATCH_SIZE) return { ok: false, error: installationError(ERROR_CODES.PLUGIN_INSTALL_BATCH_TOO_LARGE, '批量安装数量超过上限', { maxBatchSize: MAX_INSTALL_BATCH_SIZE }) };
  const packages: PluginPackage[] = [];
  for (const input of inputs) {
    const result = validatePackage(input);
    if (!result.ok) return result;
    packages.push(result.value);
  }
  const toolNames = validatePluginToolNames(packages);
  if (!toolNames.ok) return toolNames;
  return { ok: true, value: { packages, manifests: packages.map((item) => item.manifest) } };
}

/** 校验当前批次和已有注册记录之间的 OpenAI 工具名归一化冲突。 */
export function validatePluginToolNames(packages: readonly PluginPackage[], existingPluginIds: Iterable<string> = []): PluginHostResult<readonly PluginPackage[]> {
  const owners = new Map<string, string>();
  for (const pluginId of existingPluginIds) owners.set(normalizePluginToolName(pluginId), pluginId);
  for (const plugin of packages.filter((item) => item.manifest.pluginKind === 'business')) {
    const pluginId = plugin.manifest.pluginId;
    const toolName = normalizePluginToolName(pluginId);
    const owner = owners.get(toolName);
    if (owner !== undefined && owner !== pluginId) {
      return {
        ok: false,
        error: installationError(ERROR_CODES.PLUGIN_TOOL_NAME_CONFLICT, 'Plugin 工具名称冲突', {
          pluginId,
          conflictingPluginId: owner,
          toolName
        })
      };
    }
    owners.set(toolName, pluginId);
  }
  return { ok: true, value: packages };
}

/** 校验排序后的 Manifest 不会破坏当前注册表。 */
export function validateInstallSet(manifests: PluginManifest[], existingIds: ReadonlySet<string>): PluginHostResult<PluginManifest[]> {
  for (const manifest of manifests) {
    if (existingIds.has(manifest.pluginId)) return { ok: false, error: installationError(ERROR_CODES.PLUGIN_DUPLICATE_ID, 'Plugin 已安装', { pluginId: manifest.pluginId }) };
  }
  return { ok: true, value: manifests };
}

/** 创建与调用方输入隔离的安装记录。 */
export function createRecord(plugin: PluginPackage): PluginRecord {
  const functions = new Map(plugin.functions.map((item) => [item.definition.functionId, {
    definition: structuredClone(item.definition),
    operations: structuredClone(item.operations),
    handler: item.handler
  }]));
  return { manifest: structuredClone(plugin.manifest), state: 'installed', functions };
}
