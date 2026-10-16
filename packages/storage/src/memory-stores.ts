/**
 * 提供不依赖外部服务的内存存储适配器。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { EventEnvelope } from '@iar/contracts';
import {
  StorageConflictError,
  type EventStore,
  type RegistryEntry,
  type RegistryStore,
  type SnapshotRecord,
  type SnapshotStore
} from './types.js';
import { cloneEvent, cloneJsonValue, cloneSnapshot } from './json.js';

/** 事件事实源的内存实现。 */
export class InMemoryEventStore implements EventStore {
  /** 内部事件只允许追加，外部读取均为深拷贝。 */
  private readonly events = new Map<string, EventEnvelope>();

  /** 追加一个不存在的事件 ID。 */
  public async append(event: EventEnvelope): Promise<void> {
    if (this.events.has(event.eventId)) throw new StorageConflictError(`事件已存在: ${event.eventId}`);
    const clonedEvent = cloneEvent(event);
    this.events.set(event.eventId, clonedEvent);
  }

  /** 先检查整批事件 ID，再一次性追加，避免部分写入。 */
  public async appendAll(events: readonly EventEnvelope[]): Promise<void> {
    const ids = new Set<string>();
    for (const event of events) {
      if (ids.has(event.eventId) || this.events.has(event.eventId)) throw new StorageConflictError(`事件已存在: ${event.eventId}`);
      ids.add(event.eventId);
    }
    const clonedEvents = events.map((event) => cloneEvent(event));
    for (const event of clonedEvents) this.events.set(event.eventId, event);
  }

  /** 返回按插入顺序排列的事件快照。 */
  public async list(runId?: string): Promise<EventEnvelope[]> {
    return [...this.events.values()]
      .filter((event) => runId === undefined || event.runId === runId)
      .map((event) => cloneEvent(event));
  }

  /** 返回指定事件的快照。 */
  public async get(eventId: string): Promise<EventEnvelope | undefined> {
    const event = this.events.get(eventId);
    return event ? cloneEvent(event) : undefined;
  }
}

/** BehaviorContext 快照的内存实现。 */
export class InMemorySnapshotStore implements SnapshotStore {
  /** 每个运行只保留最新快照。 */
  private readonly snapshots = new Map<string, SnapshotRecord>();

  /** 保存深拷贝快照。 */
  public async save(snapshot: SnapshotRecord): Promise<void> {
    const current = this.snapshots.get(snapshot.runId);
    if (current && snapshot.revision < current.revision) {
      throw new StorageConflictError(`快照版本回退: ${snapshot.runId}`);
    }
    if (current && snapshot.revision === current.revision && current.eventId !== snapshot.eventId) {
      throw new StorageConflictError(`快照版本冲突: ${snapshot.runId}`);
    }
    this.snapshots.set(snapshot.runId, cloneSnapshot(snapshot));
  }

  /** 读取深拷贝快照。 */
  public async get(runId: string): Promise<SnapshotRecord | undefined> {
    const snapshot = this.snapshots.get(runId);
    return snapshot ? cloneSnapshot(snapshot) : undefined;
  }

  /** 删除当前运行快照。 */
  public async delete(runId: string): Promise<void> {
    this.snapshots.delete(runId);
  }
}

/** 注册表条目的内存实现。 */
export class InMemoryRegistryStore implements RegistryStore {
  /** 注册内容以 JSON 快照形式隔离调用方引用。 */
  private readonly entries = new Map<string, RegistryEntry>();

  /** 保存深拷贝条目。 */
  public async put(entry: RegistryEntry): Promise<void> {
    this.entries.set(entry.key, cloneJsonValue(entry));
  }

  /** 只在条目不存在时写入，供持久化幂等门禁使用。 */
  public async putIfAbsent(entry: RegistryEntry): Promise<boolean> {
    if (this.entries.has(entry.key)) return false;
    this.entries.set(entry.key, cloneJsonValue(entry));
    return true;
  }

  /** 读取深拷贝条目。 */
  public async get(key: string): Promise<RegistryEntry | undefined> {
    const entry = this.entries.get(key);
    return entry ? cloneJsonValue(entry) : undefined;
  }

  /** 返回按 key 排序的条目快照。 */
  public async list(): Promise<RegistryEntry[]> {
    return [...this.entries.values()]
      .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
      .map((entry) => cloneJsonValue(entry));
  }

  /** 删除一个注册条目。 */
  public async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

