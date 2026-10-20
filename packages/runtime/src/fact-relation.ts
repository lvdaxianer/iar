/**
 * 提供基于有序可信事实链的通用历史关系解析。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
import type { VerifiedFactHistory, VerifiedFactRecord } from '@iar/contracts';

/** 历史引用允许的相对偏移上限，与 SemanticFrame v2 保持一致。 */
const MAX_FACT_RELATION_OFFSET = 64;

/** 运行时允许的事实链关系。 */
export type FactRelation = 'current' | 'previous' | 'next' | 'first' | 'last' | 'offset';

/** 模型归一化后的不透明历史关系引用。 */
export type FactRelationReference = {
  relation: FactRelation;
  anchorRecordId?: string;
  scope?: 'same_fact_chain';
  offset?: number;
};

/** 关系解析的稳定失败原因。 */
export type FactRelationFailure = 'empty_history' | 'missing_anchor' | 'invalid_anchor' | 'invalid_offset' | 'out_of_range';

/** 关系解析结果，成功值只包含已存在的可信记录。 */
export type FactRelationResult =
  | { ok: true; record: VerifiedFactRecord }
  | { ok: false; reason: FactRelationFailure };

/** 按有序事实链解析一个通用历史关系。 */
export function resolveFactRelation(history: VerifiedFactHistory, reference: FactRelationReference): FactRelationResult {
  const records = orderedRecords(history);
  if (records.length === 0) return { ok: false, reason: 'empty_history' };
  if (reference.relation === 'first') return resultAt(records, 0);
  if (reference.relation === 'last') return resultAt(records, records.length - 1);
  const anchorIndex = findAnchorIndex(records, reference.anchorRecordId ?? history.focusRecordId);
  if (anchorIndex === undefined) return reference.anchorRecordId || history.focusRecordId ? { ok: false, reason: 'invalid_anchor' } : { ok: false, reason: 'missing_anchor' };
  return resultAt(records, relationIndex(reference, anchorIndex));
}

/** 复制并按 sequence 排序，避免解析器修改调用方的历史数组。 */
function orderedRecords(history: VerifiedFactHistory): VerifiedFactRecord[] {
  return [...history.records].sort((left, right) => left.sequence - right.sequence);
}

/** 查找显式或焦点锚点在当前会话中的位置。 */
function findAnchorIndex(records: VerifiedFactRecord[], anchorRecordId: string | undefined): number | undefined {
  if (anchorRecordId === undefined) return undefined;
  const index = records.findIndex((record) => record.recordId === anchorRecordId);
  return index >= 0 ? index : undefined;
}

/** 将关系映射为事实链中的目标位置。 */
function relationIndex(reference: FactRelationReference, anchorIndex: number): number | undefined {
  if (reference.relation === 'current') return anchorIndex;
  if (reference.relation === 'previous') return anchorIndex - 1;
  if (reference.relation === 'next') return anchorIndex + 1;
  if (reference.relation === 'offset') return validOffset(reference.offset) ? anchorIndex + reference.offset : undefined;
  return undefined;
}

/** 校验 offset 是有界整数，避免模型通过关系读取任意范围。 */
function validOffset(offset: number | undefined): offset is number {
  return offset !== undefined && Number.isSafeInteger(offset) && Math.abs(offset) <= MAX_FACT_RELATION_OFFSET;
}

/** 将位置转换为成功记录或稳定失败原因。 */
function resultAt(records: VerifiedFactRecord[], index: number | undefined): FactRelationResult {
  if (index === undefined) return { ok: false, reason: 'invalid_offset' };
  const record = records[index];
  return record === undefined ? { ok: false, reason: 'out_of_range' } : { ok: true, record: structuredClone(record) };
}
