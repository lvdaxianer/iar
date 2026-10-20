/**
 * 管理插件生命周期和拒绝事件的不可变内存日志。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { SCHEMA_VERSIONS, type EventEnvelope, type JsonValue, type PluginManifest } from '@iar/contracts';
import type { PluginEventInput, PluginState } from './types.js';

/** 可写入事件日志的生命周期阶段。 */
type LifecycleEventState = Exclude<PluginState, 'unloaded'> | 'unloaded';

/**
 * 提供不可变快照和单调事件 ID 的插件事件日志。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class PluginEventLog {
  /** 内部追加日志，调用方只能获得深拷贝快照。 */
  private readonly eventLog: EventEnvelope[] = [];

  /** 内部单调递增的事件序号。 */
  private eventSequence = 0;

  /**
   * 返回事件日志的只读深拷贝。
   *
   * @returns 事件日志快照
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public get events(): readonly EventEnvelope[] {
    return this.eventLog.map((event) => structuredClone(event));
  }

  /**
   * 返回指定插件的历史事件深拷贝。
   *
   * @param pluginId - 插件稳定标识
   * @returns 与插件关联的事件快照
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public history(pluginId: string): EventEnvelope[] {
    return this.eventLog
      .filter((event) => this.eventBelongsTo(event, pluginId))
      .map((event) => structuredClone(event));
  }

  /**
   * 追加一个插件拒绝事件。
   *
   * @param pluginId - 被拒绝的插件标识
   * @param reasonCode - 稳定拒绝错误码
   * @returns 不返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public reject(pluginId: string, reasonCode: string): void {
    this.emit({ eventName: 'plugin.rejected', pluginId, reasonCode });
  }

  /**
   * 追加一个生命周期阶段事件。
   *
   * @param manifest - 产生事件的插件 Manifest
   * @param state - 目标生命周期状态
   * @param from - 可选的前一生命周期状态
   * @returns 不返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public lifecycle(manifest: PluginManifest, state: LifecycleEventState, from?: PluginState): void {
    const input: PluginEventInput = { eventName: `plugin.${state}`, pluginId: manifest.pluginId, to: state };
    if (from) input.from = from;
    this.emit(input);
  }

  /**
   * 判断事件是否属于指定插件。
   *
   * @param event - 待判断事件
   * @param pluginId - 目标插件标识
   * @returns 是否属于目标插件
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private eventBelongsTo(event: EventEnvelope, pluginId: string): boolean {
    const payload = event.payload;
    return typeof payload === 'object' && payload !== null && !Array.isArray(payload) && payload.pluginId === pluginId;
  }

  /**
   * 追加事件并保持载荷可 JSON 序列化。
   *
   * @param input - 生命周期或拒绝事件输入
   * @returns 不返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private emit(input: PluginEventInput): void {
    const payload = this.createPayload(input);
    this.eventSequence += 1;
    this.eventLog.push({
      schemaVersion: SCHEMA_VERSIONS.event,
      eventId: `plugin-event-${this.eventSequence}`,
      eventName: input.eventName,
      occurredAt: new Date().toISOString(),
      runId: `plugin:${input.pluginId}`,
      correlationId: `plugin:${input.pluginId}`,
      payload
    });
  }

  /**
   * 创建事件载荷并省略未提供的可选字段。
   *
   * @param input - 生命周期或拒绝事件输入
   * @returns JSON 安全的事件载荷
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private createPayload(input: PluginEventInput): Record<string, JsonValue> {
    const payload: Record<string, JsonValue> = { pluginId: input.pluginId };
    if (input.functionId) payload.functionId = input.functionId;
    if (input.from) payload.from = input.from;
    if (input.to) payload.to = input.to;
    if (input.reasonCode) payload.reasonCode = input.reasonCode;
    return payload;
  }
}
