/**
 * 提供远程插件分发的内存当前版本、版本历史和审计存储。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { DistributionAuditRecord, DistributionRecord, DistributionStore } from './types.js';

/**
 * 适合确定性测试和嵌入式演练的不可变分发 store。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class InMemoryDistributionStore implements DistributionStore {
  private readonly currents = new Map<string, DistributionRecord>();
  private readonly versions = new Map<string, DistributionRecord[]>();
  private readonly audits: DistributionAuditRecord[] = [];

  /**
   * 返回当前版本的深拷贝。
   * @param pluginId - 插件稳定标识
   * @returns 当前分发记录或 undefined
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public current(pluginId: string): DistributionRecord | undefined {
    const value = this.currents.get(pluginId);
    return value ? structuredClone(value) : undefined;
  }

  /**
   * 返回按提交顺序排列的 immutable 版本历史。
   * @param pluginId - 插件稳定标识
   * @returns 版本历史副本
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public history(pluginId: string): readonly DistributionRecord[] {
    return structuredClone(this.versions.get(pluginId) ?? []);
  }

  /**
   * 返回按时间追加的审计副本，可按 pluginId 过滤。
   * @param pluginId - 可选插件稳定标识
   * @returns 审计记录副本
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public audit(pluginId?: string): readonly DistributionAuditRecord[] {
    const values = pluginId ? this.audits.filter((record) => record.pluginId === pluginId) : this.audits;
    return structuredClone(values);
  }

  /**
   * 原子提交当前版本并把上一版本保存在 immutable history。
   * @param pluginId - 插件稳定标识
   * @param current - 新当前记录
   * @param previous - 可选旧版本记录
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public commit(pluginId: string, current: DistributionRecord, previous?: DistributionRecord): void {
    const history = this.versions.get(pluginId) ?? [];
    if (previous) history.push(structuredClone(previous));
    this.currents.set(pluginId, structuredClone(current));
    this.versions.set(pluginId, history);
  }

  /**
   * 原子提交当前版本、版本历史和 accepted 审计。
   * @param pluginId - 插件稳定标识
   * @param current - 新当前记录
   * @param previous - 可选旧版本记录
   * @param audit - 与提交绑定的成功审计
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public commitAccepted(pluginId: string, current: DistributionRecord, previous: DistributionRecord | undefined, audit: DistributionAuditRecord): void {
    const history = this.versions.get(pluginId) ?? [];
    const nextHistory = previous ? [...history, structuredClone(previous)] : history;
    const nextCurrent = structuredClone(current);
    const nextAudit = structuredClone(audit);
    this.currents.set(pluginId, nextCurrent);
    this.versions.set(pluginId, nextHistory);
    this.audits.push(nextAudit);
  }

  /**
   * 追加不含秘密正文的审计记录。
   * @param record - 已脱敏审计记录
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public appendAudit(record: DistributionAuditRecord): void {
    this.audits.push(structuredClone(record));
  }
}
