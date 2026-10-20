/**
 * 从 PluginHost 当前记录派生 Function provider 索引。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
import type { FunctionDefinition } from '@iar/contracts';
import type { PluginFunctionRecord, PluginRecord } from './types.js';

/** FunctionRegistry 对外暴露的 Plugin provider 快照。 */
export type FunctionProvider = {
  pluginId: string;
  functionId: string;
  definition: FunctionDefinition;
  operations: readonly import('@iar/contracts').PluginOperation[];
  handler: PluginFunctionRecord['handler'];
};

/**
 * 管理从 Plugin 生命周期派生的 Function 索引。
 *
 * Registry 不是授权源，所有返回值都来自当前 PluginHost 记录。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
export class FunctionRegistry {
  private providersByFunction = new Map<string, FunctionProvider[]>();

  /**
   * 用当前启用 Plugin 快照替换索引。
   *
   * @param records - PluginHost 当前记录
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-21
   */
  public replace(records: readonly PluginRecord[]): void {
    const next = new Map<string, FunctionProvider[]>();
    for (const record of records) {
      if (record.state !== 'enabled' || record.manifest.pluginKind !== 'business') continue;
      for (const [functionId, functionRecord] of record.functions) {
        const providers = next.get(functionId) ?? [];
        providers.push({ pluginId: record.manifest.pluginId, functionId, definition: structuredClone(functionRecord.definition), operations: structuredClone(functionRecord.operations), handler: functionRecord.handler });
        next.set(functionId, providers);
      }
    }
    for (const providers of next.values()) providers.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
    this.providersByFunction = next;
  }

  /** 返回当前可路由的 Function 定义。 */
  public list(): readonly FunctionDefinition[] {
    return [...this.providersByFunction.entries()].map(([functionId, providers]) => {
      const definition = providers[0]?.definition;
      if (!definition) throw new Error(`Function provider 缺失: ${functionId}`);
      return structuredClone(definition);
    });
  }

  /** 返回指定 Function 的当前 Plugin providers。 */
  public providers(functionId: string): readonly FunctionProvider[] {
    return (this.providersByFunction.get(functionId) ?? []).map((provider) => ({
      ...provider,
      definition: structuredClone(provider.definition),
      operations: structuredClone(provider.operations)
    }));
  }

  /** 返回指定 Function 的公共定义。 */
  public get(functionId: string): FunctionDefinition | undefined {
    const provider = this.providersByFunction.get(functionId)?.[0];
    return provider ? structuredClone(provider.definition) : undefined;
  }
}
