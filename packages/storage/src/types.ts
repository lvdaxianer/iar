/**
 * 定义 IAR 持久化边界和统一存储记录类型。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { BehaviorContext, EventEnvelope, JsonValue } from '@iar/contracts';

/** 事件事实源的读写接口。 */
export interface EventStore {
  /** 追加一个不可变事件。 */
  append(event: EventEnvelope): Promise<void>;
  /** 按输入顺序原子追加多个事件。 */
  appendAll(events: readonly EventEnvelope[]): Promise<void>;
  /** 查询指定运行的有序事件；不传 runId 时返回全部事件。 */
  list(runId?: string): Promise<EventEnvelope[]>;
  /** 按事件 ID 查询事实。 */
  get(eventId: string): Promise<EventEnvelope | undefined>;
}

/** 行为上下文快照记录。 */
export type SnapshotRecord = {
  runId: string;
  eventId: string;
  revision: number;
  context: BehaviorContext;
};

/** 快照读写接口，每个 runId 保留最新的可恢复视图。 */
export interface SnapshotStore {
  /** 保存或替换一个运行快照。 */
  save(snapshot: SnapshotRecord): Promise<void>;
  /** 读取一个运行的最新快照。 */
  get(runId: string): Promise<SnapshotRecord | undefined>;
  /** 删除一个运行快照。 */
  delete(runId: string): Promise<void>;
}

/** 注册表中的可持久化 JSON 条目。 */
export type RegistryEntry = {
  key: string;
  value: JsonValue;
};

/** 插件、规则和运行时配置共用的键值存储边界。 */
export interface RegistryStore {
  /** 保存或替换一个注册条目。 */
  put(entry: RegistryEntry): Promise<void>;
  /** 只在 key 不存在时保存条目，并返回是否成功。 */
  putIfAbsent(entry: RegistryEntry): Promise<boolean>;
  /** 读取一个注册条目。 */
  get(key: string): Promise<RegistryEntry | undefined>;
  /** 列出所有注册条目，并按 key 稳定排序。 */
  list(): Promise<RegistryEntry[]>;
  /** 删除一个注册条目。 */
  delete(key: string): Promise<void>;
}

/** 存储适配器冲突或非法输入时抛出的稳定错误。 */
export class StorageConflictError extends Error {
  /** 创建一个表示持久化冲突的错误。 */
  public constructor(message: string) {
    super(message);
    this.name = 'StorageConflictError';
  }
}

/** 存储输入不满足公共契约或可持久化边界时抛出的错误。 */
export class StorageValidationError extends Error {
  /** 创建一个表示存储输入无效的错误。 */
  public constructor(message: string) {
    super(message);
    this.name = 'StorageValidationError';
  }
}
