/**
 * 提供 Action 幂等键门禁，避免重试产生第二次副作用。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { ERROR_CODES, SCHEMA_VERSIONS, type ActionDefinition, type ContractErrorResult } from '@iar/contracts';

/** Runtime 需要的最小 RegistryStore 结构，避免核心包绑定存储实现。 */
type RegistryStoreLike = {
  get(key: string): Promise<{ key: string; value: import('@iar/contracts').JsonValue } | undefined>;
  putIfAbsent(entry: { key: string; value: import('@iar/contracts').JsonValue }): Promise<boolean>;
  list(): Promise<Array<{ key: string; value: import('@iar/contracts').JsonValue }>>;
};

/** Action 幂等记录的持久化边界。 */
export interface ActionIdempotencyStore {
  /** 按幂等键读取第一次 Action。 */
  get(key: string): Promise<ActionDefinition | undefined>;
  /** 原子写入第一次 Action，已存在时返回 false。 */
  putIfAbsent(action: ActionDefinition): Promise<boolean>;
  /** 返回持久化的全部 Action。 */
  list(): Promise<ActionDefinition[]>;
}

/** 使用 RegistryStore 保存 Action 幂等记录，支持重启后恢复。 */
export class RegistryActionIdempotencyStore implements ActionIdempotencyStore {
  /** 避免与其他 Registry 条目发生 key 冲突。 */
  private static readonly prefix = 'iar.action.idempotency:';

  /** 创建注册表适配器。 */
  public constructor(private readonly registry: RegistryStoreLike) {}

  /** 读取一个持久化 Action。 */
  public async get(key: string): Promise<ActionDefinition | undefined> {
    const entry = await this.registry.get(`${RegistryActionIdempotencyStore.prefix}${key}`);
    return entry ? entry.value as ActionDefinition : undefined;
  }

  /** 使用 RegistryStore 的 putIfAbsent 实现原子首次写入。 */
  public async putIfAbsent(action: ActionDefinition): Promise<boolean> {
    const entry = {
      key: `${RegistryActionIdempotencyStore.prefix}${action.idempotencyKey}`,
      value: action
    };
    return this.registry.putIfAbsent(entry);
  }

  /** 读取并转换全部幂等记录。 */
  public async list(): Promise<ActionDefinition[]> {
    const entries = await this.registry.list();
    return entries
      .filter((entry) => entry.key.startsWith(RegistryActionIdempotencyStore.prefix))
      .map((entry) => entry.value as ActionDefinition);
  }
}

/** 默认的内存幂等记录，供嵌入式单进程场景使用。 */
class InMemoryActionIdempotencyStore implements ActionIdempotencyStore {
  /** 进程内的首次 Action 记录。 */
  private readonly actions = new Map<string, ActionDefinition>();

  /** 读取内存 Action。 */
  public async get(key: string): Promise<ActionDefinition | undefined> {
    const action = this.actions.get(key);
    return action ? structuredClone(action) : undefined;
  }

  /** 原子写入内存 Action。 */
  public async putIfAbsent(action: ActionDefinition): Promise<boolean> {
    if (this.actions.has(action.idempotencyKey)) return false;
    this.actions.set(action.idempotencyKey, structuredClone(action));
    return true;
  }

  /** 返回内存 Action 快照。 */
  public async list(): Promise<ActionDefinition[]> {
    return [...this.actions.values()].map((action) => structuredClone(action));
  }
}

/** Action 幂等门禁的显式结果。 */
export type ActionStartResult =
  | { ok: true; value: ActionDefinition }
  | { ok: false; error: ContractErrorResult; existing: ActionDefinition };

/** 记录已接受的 Action 并拒绝重复幂等键。 */
export class ActionIdempotencyLedger {
  /** 幂等记录由内存或 RegistryStore 适配器提供。 */
  private readonly store: ActionIdempotencyStore;

  /** 创建幂等门禁；传入持久化 Store 可跨重启恢复。 */
  public constructor(store: ActionIdempotencyStore = new InMemoryActionIdempotencyStore()) {
    this.store = store;
  }

  /** 首次接受 Action，重复键只返回稳定错误和第一次 Action。 */
  public async start(action: ActionDefinition): Promise<ActionStartResult> {
    const accepted = await this.store.putIfAbsent(action);
    if (!accepted) {
      const existing = await this.store.get(action.idempotencyKey);
      if (!existing) throw new Error(`幂等记录丢失: ${action.idempotencyKey}`);
      return {
        ok: false,
        error: {
          schemaVersion: SCHEMA_VERSIONS.error,
          code: ERROR_CODES.ACTION_DUPLICATE,
          message: '幂等键已经启动过 Action',
          retryable: false,
          details: { idempotencyKey: action.idempotencyKey, actionId: existing.actionId }
        },
        existing: structuredClone(existing)
      };
    }
    return { ok: true, value: structuredClone(action) };
  }

  /** 返回已接受 Action 的深拷贝列表。 */
  public async started(): Promise<ActionDefinition[]> {
    return this.store.list();
  }
}
