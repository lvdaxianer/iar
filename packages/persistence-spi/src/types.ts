/**
 * 定义可替换会话持久化 Provider 的稳定 SPI。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
import type { BehaviorContext, EventEnvelope, JsonValue } from '@iar/contracts';

/** 当前 Provider SPI 的版本标识。 */
export const PERSISTENCE_API_VERSION = 'iar.persistence/v1' as const;

/** Provider 标识和消息边界的最大长度。 */
export const MAX_PERSISTENCE_ID_LENGTH = 256;

/** 会话运行期间跨消息、事件和快照传递的稳定身份。 */
export type SessionIdentity = {
  /** 跨多个请求保持不变的会话聚合标识。 */
  sessionId: string;
  /** 当前可恢复工作流运行标识。 */
  runId: string;
  /** 当前请求和模型调用链路标识。 */
  traceId?: string;
  /** 当前消息标识；非消息事件可以省略。 */
  messageId?: string;
};

/** 会话消息角色。 */
export type SessionMessageRole = 'user' | 'assistant' | 'system';

/** 需要由 Provider 保存的会话消息。 */
export type SessionMessage = {
  /** 一条消息在当前会话中的稳定标识。 */
  messageId: string;
  /** 消息所属角色。 */
  role: SessionMessageRole;
  /** 面向会话恢复的消息正文。 */
  content: string;
  /** 消息产生时间，使用 ISO-8601 字符串。 */
  occurredAt: string;
  /** 可选的安全结构化摘要，不作为模型指令。 */
  metadata?: JsonValue;
};

/** Provider 宣布的能力和 SPI 版本。 */
export type PersistenceProviderManifest = {
  /** Provider 的稳定注册标识。 */
  providerId: string;
  /** 必须匹配 PERSISTENCE_API_VERSION。 */
  apiVersion: string;
  /** Provider 支持的持久化能力集合。 */
  capabilities: readonly string[];
};

/** 包含会话关联的结构化上下文快照。 */
export type SessionSnapshotRecord = {
  /** 快照所属会话。 */
  sessionId: string;
  /** 快照关联的工作流运行。 */
  runId: string;
  /** 生成该快照的最后一个事件。 */
  eventId: string;
  /** 同一会话内单调递增的快照版本。 */
  revision: number;
  /** 经过契约校验的当前结构化上下文。 */
  context: BehaviorContext;
};

/** Provider 工厂参数，保持 JSON 边界以支持外部包配置。 */
export type PersistenceProviderOptions = JsonValue | undefined;

/** 可替换的会话持久化 Provider。 */
export interface SessionPersistenceProvider {
  /** Provider 的公开 Manifest。 */
  readonly manifest: PersistenceProviderManifest;
  /** 初始化数据库连接、工作线程或远程客户端。 */
  open(options: PersistenceProviderOptions): Promise<void>;
  /** 保存一条消息，必须按 messageId 幂等。 */
  appendMessage(identity: SessionIdentity, message: SessionMessage): Promise<void>;
  /** 保存不可变事实事件，必须按 eventId 幂等。 */
  appendEvent(identity: SessionIdentity, event: EventEnvelope): Promise<void>;
  /** 保存会话最新结构化快照，必须执行 revision 防旧覆盖。 */
  saveSnapshot(identity: SessionIdentity, snapshot: SessionSnapshotRecord): Promise<void>;
  /** 读取会话最新有效快照。 */
  loadSnapshot(sessionId: string): Promise<SessionSnapshotRecord | undefined>;
  /** 读取会话事件，结果按持久化顺序返回。 */
  listEvents(sessionId: string): Promise<EventEnvelope[]>;
  /** 读取会话消息，结果按消息产生顺序返回。 */
  listMessages(sessionId: string): Promise<SessionMessage[]>;
  /** 等待已接受的异步写入完成。 */
  flush(): Promise<void>;
  /** 释放 Provider 持有的连接和线程资源。 */
  close(): Promise<void>;
}

/** 外部 Provider 包导出的工厂函数。 */
export type PersistenceProviderFactory = (
  options: PersistenceProviderOptions
) => SessionPersistenceProvider | Promise<SessionPersistenceProvider>;

/** Provider 包的标准动态加载模块形状。 */
export type PersistenceProviderModule = {
  manifest: PersistenceProviderManifest;
  createProvider: PersistenceProviderFactory;
};

/** SPI 输入校验失败时使用的稳定错误。 */
export class PersistenceValidationError extends Error {
  /** @param code - 稳定错误码 @param message - 不包含密钥的诊断信息 */
  public constructor(public readonly code: 'session_identity_invalid' | 'provider_manifest_invalid', message: string) {
    super(message);
    this.name = 'PersistenceValidationError';
  }
}

/**
 * 校验并复制会话身份，避免 Provider 持有调用方可变对象。
 *
 * @param input - 待校验的身份对象
 * @returns 可安全传给 Provider 的身份副本
 * @throws PersistenceValidationError 当字段为空、过长或不是字符串时
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
export function validateSessionIdentity(input: unknown): SessionIdentity {
  if (!isPlainObject(input)) throw new PersistenceValidationError('session_identity_invalid', '会话身份必须是对象');
  const sessionId = readIdentifier(input.sessionId);
  const runId = readIdentifier(input.runId);
  const traceId = readOptionalIdentifier(input.traceId);
  const messageId = readOptionalIdentifier(input.messageId);
  return { sessionId, runId, ...(traceId === undefined ? {} : { traceId }), ...(messageId === undefined ? {} : { messageId }) };
}

/**
 * 校验 Provider Manifest，确保动态加载不会接受未知 SPI。
 *
 * @param input - 待校验的 Manifest
 * @returns 可安全注册的 Manifest 副本
 * @throws PersistenceValidationError 当版本、标识或能力不合法时
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
export function validatePersistenceProviderManifest(input: unknown): PersistenceProviderManifest {
  if (!isPlainObject(input) || input.apiVersion !== PERSISTENCE_API_VERSION) throw new PersistenceValidationError('provider_manifest_invalid', 'Provider SPI 版本不支持');
  const providerId = readIdentifier(input.providerId);
  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0 || !input.capabilities.every(isNonEmptyString)) throw new PersistenceValidationError('provider_manifest_invalid', 'Provider 能力不能为空');
  return { providerId, apiVersion: PERSISTENCE_API_VERSION, capabilities: [...new Set(input.capabilities)] };
}

/** 判断值是否为无原型普通对象。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** 读取必填标识并统一校验长度。 */
function readIdentifier(value: unknown): string {
  if (!isNonEmptyString(value) || value.length > MAX_PERSISTENCE_ID_LENGTH) throw new PersistenceValidationError('session_identity_invalid', '持久化标识无效');
  return value;
}

/** 读取可选标识；未提供时保持 undefined。 */
function readOptionalIdentifier(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return readIdentifier(value);
}

/** 判断字符串是否包含有效的非空内容。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
