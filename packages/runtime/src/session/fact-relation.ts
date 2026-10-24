/**
 * 提供基于有序可信事实链的通用历史关系解析。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
import { MAX_CLARIFICATION_OPTIONS, type VerifiedFactHistory, type VerifiedFactRecord } from '@iar/contracts';

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

/** 带原文的通用关系引用，供候选状态保存用户指代。 */
export type FactRelationCandidateReference = FactRelationReference & { text: string };

/** 候选解析结果，歧义时只暴露有限的可信事实记录。 */
export type FactRelationCandidateResult =
  | { status: 'resolved'; record: VerifiedFactRecord }
  | { status: 'ambiguous'; candidates: VerifiedFactRecord[] }
  | { status: 'unresolved'; reason: FactRelationFailure };

/** 两个有序上下文集合共用的引用作用域。 */
export type OrderedReferenceScope = 'conversation_turn' | 'fact_history';

/** 模型输出的有序上下文关系，不携带业务值或执行权限。 */
export type OrderedReference = {
  scope: OrderedReferenceScope;
  relation: FactRelation;
  anchorId?: string;
  anchorSequence?: number;
  targetId?: string;
  targetSequence?: number;
  offset?: number;
};

/** 有序上下文集合的最小安全投影。 */
export type OrderedReferenceItem = { id: string; sequence: number };

/** 通用有序关系解析结果。 */
export type OrderedReferenceCandidateResult<T extends OrderedReferenceItem> =
  | { status: 'resolved'; item: T }
  | { status: 'ambiguous'; candidates: T[] }
  | { status: 'unresolved'; reason: 'empty_history' | 'missing_anchor' | 'invalid_anchor' | 'invalid_target' | 'invalid_offset' | 'out_of_range' };

/**
 * 在调用方选定的有序集合中解析模型引用。
 * 集合由调用方按 scope 选择，解析器不会从 text、另一集合或业务字段猜测目标。
 */
export function resolveOrderedReferenceCandidates<T extends OrderedReferenceItem>(input: { items: readonly T[]; focusId?: string }, reference: OrderedReference): OrderedReferenceCandidateResult<T> {
  const items = [...input.items].sort((left, right) => left.sequence - right.sequence);
  if (items.length === 0) return { status: 'unresolved', reason: 'empty_history' };
  if (reference.relation === 'offset' && !validOffset(reference.offset)) return { status: 'unresolved', reason: 'invalid_offset' };
  const direct = directTarget(items, reference);
  if (direct.status !== 'none') return direct.result;
  if (reference.relation === 'first') return orderedResultAt(items, 0);
  if (reference.relation === 'last') return orderedResultAt(items, items.length - 1);
  const anchor = resolveAnchor(items, input.focusId, reference);
  if (anchor.status !== 'resolved') return anchor;
  return orderedResultAt(items, orderedRelationIndex(reference, anchor.index));
}

type DirectTargetResult<T extends OrderedReferenceItem> = { status: 'none' } | { status: 'resolved'; result: OrderedReferenceCandidateResult<T> };

/** 解析模型直接给出的目标；target 只能和 current 关系组合。 */
function directTarget<T extends OrderedReferenceItem>(items: T[], reference: OrderedReference): DirectTargetResult<T> {
  if (reference.targetId === undefined && reference.targetSequence === undefined) return { status: 'none' };
  if (reference.relation !== 'current') return { status: 'resolved', result: { status: 'unresolved', reason: 'invalid_target' } };
  const item = items.find((candidate) => (reference.targetId === undefined || candidate.id === reference.targetId) && (reference.targetSequence === undefined || candidate.sequence === reference.targetSequence));
  return item === undefined ? { status: 'resolved', result: { status: 'unresolved', reason: 'invalid_target' } } : { status: 'resolved', result: { status: 'resolved', item: structuredClone(item) } };
}

/** 解析显式锚点或当前焦点，并校验 ID 与序号必须指向同一项。 */
function resolveAnchor<T extends OrderedReferenceItem>(items: T[], focusId: string | undefined, reference: OrderedReference): { status: 'resolved'; index: number } | { status: 'unresolved'; reason: 'missing_anchor' | 'invalid_anchor' } {
  const anchorId = reference.anchorId ?? focusId;
  const anchorSequence = reference.anchorSequence;
  if (anchorId === undefined && anchorSequence === undefined) return { status: 'unresolved', reason: 'missing_anchor' };
  const index = items.findIndex((item) => (anchorId === undefined || item.id === anchorId) && (anchorSequence === undefined || item.sequence === anchorSequence));
  return index >= 0 ? { status: 'resolved', index } : { status: 'unresolved', reason: 'invalid_anchor' };
}

/** 将关系转换成有序集合中的目标位置。 */
function orderedRelationIndex(reference: OrderedReference, anchorIndex: number): number | undefined {
  if (reference.relation === 'current') return anchorIndex;
  if (reference.relation === 'previous') return anchorIndex - 1;
  if (reference.relation === 'next') return anchorIndex + 1;
  if (reference.relation === 'offset') return anchorIndex + reference.offset!;
  return undefined;
}

/** 将目标位置转换成有界克隆结果。 */
function orderedResultAt<T extends OrderedReferenceItem>(items: T[], index: number | undefined): OrderedReferenceCandidateResult<T> {
  if (index === undefined) return { status: 'unresolved', reason: 'invalid_offset' };
  const item = items[index];
  return item === undefined ? { status: 'unresolved', reason: 'out_of_range' } : { status: 'resolved', item: structuredClone(item) };
}

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

/** 解析关系并在缺少锚点时返回有限候选，禁止运行时静默猜测。 */
export function resolveFactRelationCandidates(history: VerifiedFactHistory, reference: FactRelationCandidateReference): FactRelationCandidateResult {
  const records = orderedRecords(history);
  if (records.length === 0) return { status: 'unresolved', reason: 'empty_history' };
  const offsetError = relationOffsetError(reference);
  if (offsetError) return { status: 'unresolved', reason: offsetError };
  if (reference.relation === 'first') return resolvedAt(records, 0);
  if (reference.relation === 'last') return resolvedAt(records, records.length - 1);
  const anchorId = reference.anchorRecordId ?? history.focusRecordId;
  if (anchorId !== undefined) return anchoredCandidate(records, reference, anchorId);
  return ambiguousCandidates(records, reference);
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

/** 校验候选解析中的 offset，返回稳定失败原因。 */
function relationOffsetError(reference: FactRelationReference): FactRelationFailure | undefined {
  return reference.relation === 'offset' && !validOffset(reference.offset) ? 'invalid_offset' : undefined;
}

/** 解析带显式或焦点锚点的关系。 */
function anchoredCandidate(records: VerifiedFactRecord[], reference: FactRelationCandidateReference, anchorId: string): FactRelationCandidateResult {
  const anchorIndex = findAnchorIndex(records, anchorId);
  if (anchorIndex === undefined) return { status: 'unresolved', reason: 'invalid_anchor' };
  const index = relationIndex(reference, anchorIndex);
  if (index === undefined) return { status: 'unresolved', reason: 'invalid_offset' };
  return resolvedAt(records, index);
}

/** 计算无锚点关系的有限可能目标。 */
function ambiguousCandidates(records: VerifiedFactRecord[], reference: FactRelationCandidateReference): FactRelationCandidateResult {
  const indexes = candidateIndexes(records, reference.relation);
  if (indexes.length === 1 && indexes[0] !== undefined) return resolvedAt(records, indexes[0]);
  const candidates = indexes.slice(0, MAX_CLARIFICATION_OPTIONS).map((index) => structuredClone(records[index]!));
  return candidates.length > 0 ? { status: 'ambiguous', candidates } : { status: 'unresolved', reason: 'missing_anchor' };
}

/** 将无锚点关系转换为目标位置集合，而不是直接选择某一条记录。 */
function candidateIndexes(records: VerifiedFactRecord[], relation: FactRelation): number[] {
  if (relation === 'previous') return records.map((_record, index) => index).slice(0, -1);
  if (relation === 'next') return records.map((_record, index) => index).slice(1);
  return records.map((_record, index) => index);
}

/** 将单个目标位置转换为克隆的可信事实或稳定失败原因。 */
function resolvedAt(records: VerifiedFactRecord[], index: number): FactRelationCandidateResult {
  const record = records[index];
  return record === undefined ? { status: 'unresolved', reason: 'out_of_range' } : { status: 'resolved', record: structuredClone(record) };
}
