/**
 * 定义上下文压缩模型结果和运行时事件载荷类型。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { BehaviorContext } from './types-state.js';
import type { Static } from '@sinclair/typebox';
import type { CompactionModelStateSchema } from './schema-compaction.js';

/** 压缩结果中的指代引用。 */
export type CompactionReference = {
  /** 摘要中保留的原始指代文本。 */
  text: string;
  /** 指代解析出的稳定实体或槽位值。 */
  resolvedTo: string;
  /** 支撑该解析的不可变事件标识。 */
  sourceEventId: string;
};

/** 与模型状态 Schema 同源的候选状态类型。 */
export type CompactionModelState = Static<typeof CompactionModelStateSchema>;

/** contextCompactor 返回的最小模型结果。 */
export type CompactionResult = {
  /** 模型协议版本。 */
  schemaVersion: typeof import('./versions.js').SCHEMA_VERSIONS.compactionResult;
  /** 可展示但不可执行的历史摘要。 */
  summary: string;
  /** 由模型返回的候选状态片段。 */
  state: CompactionModelState;
  /** 摘要中的指代到事实的映射。 */
  references: CompactionReference[];
  /** 模型明确声明保留的关键事实路径。 */
  preservedFacts: string[];
  /** 模型无法确认或发现冲突时的警告。 */
  warnings: string[];
};

/** Runtime 补齐的压缩边界和审计元数据。 */
export type CompactionRuntimeMetadata = {
  /** 被压缩事件区间的起点。 */
  fromEventId: string;
  /** 被压缩事件区间的终点。 */
  toEventId: string;
  /** 压缩后保留的第一条事件。 */
  firstKeptEntryId: string;
  /** 压缩前 token 数。 */
  beforeTokenCount: number;
  /** 压缩后 token 数。 */
  afterTokenCount: number;
  /** 摘要协议版本。 */
  summaryVersion: string;
  /** 摘要生成器版本。 */
  generatorVersion: string;
};

/** 成功事件中携带的完整可执行状态和审计字段。 */
export type CompactionEventPayload = CompactionRuntimeMetadata & {
  /** Runtime 规范化后的完整行为上下文。 */
  state: BehaviorContext;
  /** 成功摘要及其版本。 */
  summary: string;
  summaryVersion: string;
  /** 模型引用、保留事实和警告。 */
  references: CompactionReference[];
  preservedFacts: string[];
  warnings: string[];
  /** Runtime 重新计算的关键字段哈希。 */
  criticalFieldHash: string;
};
