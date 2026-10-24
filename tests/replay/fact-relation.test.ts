/**
 * 验证通用历史关系只能由运行时按事实链顺序解析。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
import assert from 'node:assert/strict';
import test from 'node:test';

type Relation = 'current' | 'previous' | 'next' | 'first' | 'last' | 'offset';
type History = { records: Array<{ recordId: string; sequence: number; values: Record<string, unknown> }>; focusRecordId?: string };
type Resolver = (history: History, reference: { relation: Relation; anchorRecordId?: string; offset?: number }) => { ok: true; record: { recordId: string } } | { ok: false; reason: string };
type CandidateRecord = { recordId: string; values: Record<string, unknown> };
type CandidateResolver = (history: History, reference: { text: string; relation: Relation; anchorRecordId?: string; offset?: number }) => { status: 'resolved'; record: CandidateRecord } | { status: 'ambiguous'; candidates: CandidateRecord[] } | { status: 'unresolved'; reason: string };
type OrderedReference = { text?: string; scope: 'conversation_turn' | 'fact_history'; relation: Relation; anchorId?: string; anchorSequence?: number; targetId?: string; targetSequence?: number; offset?: number };
type OrderedItem = { id: string; sequence: number; value: string };
type OrderedResolver = (input: { items: OrderedItem[]; focusId?: string }, reference: OrderedReference) => { status: 'resolved'; item: OrderedItem } | { status: 'ambiguous'; candidates: OrderedItem[] } | { status: 'unresolved'; reason: string };

/** 创建三个有序事实记录，值只用于验证解析结果。 */
function history(): History {
  return {
    records: [
      { recordId: 'record-a', sequence: 1, values: { resultKey: 'a' } },
      { recordId: 'record-b', sequence: 2, values: { resultKey: 'b' } },
      { recordId: 'record-c', sequence: 3, values: { resultKey: 'c' } }
    ],
    focusRecordId: 'record-c'
  };
}

/** 通过公开运行时入口取得关系解析器，避免测试依赖内部实现文件。 */
async function resolver(): Promise<Resolver> {
  const runtime = await import('@iar/runtime') as unknown as { resolveFactRelation?: Resolver };
  assert.equal(typeof runtime.resolveFactRelation, 'function');
  return runtime.resolveFactRelation as Resolver;
}

/** 通过公开运行时入口取得候选解析器，保证候选集合也走公共契约。 */
async function candidateResolver(): Promise<CandidateResolver> {
  const runtime = await import('@iar/runtime') as unknown as { resolveFactRelationCandidates?: CandidateResolver };
  assert.equal(typeof runtime.resolveFactRelationCandidates, 'function');
  return runtime.resolveFactRelationCandidates as CandidateResolver;
}

/** 通过公开运行时入口取得两个有序上下文共用的关系解析器。 */
async function orderedResolver(): Promise<OrderedResolver> {
  const runtime = await import('@iar/runtime') as unknown as { resolveOrderedReferenceCandidates?: OrderedResolver };
  assert.equal(typeof runtime.resolveOrderedReferenceCandidates, 'function');
  return runtime.resolveOrderedReferenceCandidates as OrderedResolver;
}

/** 断言关系解析成功并返回记录标识。 */
function recordId(result: ReturnType<Resolver>): string {
  assert.equal(result.ok, true);
  return result.record.recordId;
}

test('按事实链顺序解析 current、previous、next、first、last 和 offset', async () => {
  const resolve = await resolver();
  const current = history();
  assert.equal(recordId(resolve(current, { relation: 'current' })), 'record-c');
  assert.equal(recordId(resolve(current, { relation: 'previous' })), 'record-b');
  assert.equal(recordId(resolve(current, { relation: 'next', anchorRecordId: 'record-b' })), 'record-c');
  assert.equal(recordId(resolve(current, { relation: 'first' })), 'record-a');
  assert.equal(recordId(resolve(current, { relation: 'last' })), 'record-c');
  assert.equal(recordId(resolve(current, { relation: 'offset', anchorRecordId: 'record-b', offset: -1 })), 'record-a');
});

test('无效锚点、无焦点和越界关系安全失败', async () => {
  const resolve = await resolver();
  assert.deepEqual(resolve({ records: history().records }, { relation: 'previous' }), { ok: false, reason: 'missing_anchor' });
  assert.deepEqual(resolve(history(), { relation: 'previous', anchorRecordId: 'record-missing' }), { ok: false, reason: 'invalid_anchor' });
  assert.deepEqual(resolve(history(), { relation: 'next' , anchorRecordId: 'record-c' }), { ok: false, reason: 'out_of_range' });
  assert.deepEqual(resolve(history(), { relation: 'offset', anchorRecordId: 'record-b', offset: 99 }), { ok: false, reason: 'invalid_offset' });
});

test('无锚点的相对关系返回有限候选而不是猜测', async () => {
  const resolve = await candidateResolver();
  const input = { records: history().records };
  const result = resolve(input, { text: 'relative', relation: 'previous' });
  assert.equal(result.status, 'ambiguous');
  if (result.status === 'ambiguous') assert.deepEqual(result.candidates.map((record) => record.recordId), ['record-a', 'record-b']);
  assert.deepEqual(input.records.map((record) => record.recordId), ['record-a', 'record-b', 'record-c']);
});

test('确定关系只返回单个克隆记录，候选解析不改写事实链', async () => {
  const resolve = await candidateResolver();
  const input = history();
  const result = resolve(input, { text: 'relative', relation: 'last' });
  assert.equal(result.status, 'resolved');
  if (result.status === 'resolved') {
    assert.equal(result.record.recordId, 'record-c');
    result.record.values.resultKey = 'changed';
  }
  assert.equal(input.records[2]?.values.resultKey, 'c');
});

test('按显式 scope 在会话轮次和事实历史之间分别解析，不读取引用文本', async () => {
  const resolve = await orderedResolver();
  const turns = { items: [{ id: 'turn-b', sequence: 2, value: '问题二' }, { id: 'turn-a', sequence: 1, value: '问题一' }, { id: 'turn-c', sequence: 3, value: '问题三' }], focusId: 'turn-c' };
  const facts = { items: [{ id: 'record-b', sequence: 2, value: '结果二' }, { id: 'record-a', sequence: 1, value: '结果一' }, { id: 'record-c', sequence: 3, value: '结果三' }], focusId: 'record-c' };
  const previousTurn = resolve(turns, { text: '第999个失败记录', scope: 'conversation_turn', relation: 'previous', anchorId: 'turn-c', anchorSequence: 3 });
  const previousFact = resolve(facts, { text: '完全不同的说法', scope: 'fact_history', relation: 'previous', anchorId: 'record-c', anchorSequence: 3 });
  assert.equal(previousTurn.status, 'resolved');
  if (previousTurn.status === 'resolved') assert.equal(previousTurn.item.id, 'turn-b');
  assert.equal(previousFact.status, 'resolved');
  if (previousFact.status === 'resolved') assert.equal(previousFact.item.id, 'record-b');
});

test('有序引用拒绝跨集合目标、锚点序号不一致和越界关系', async () => {
  const resolve = await orderedResolver();
  const input = { items: [{ id: 'turn-a', sequence: 1, value: '问题一' }, { id: 'turn-b', sequence: 2, value: '问题二' }], focusId: 'turn-b' };
  assert.deepEqual(resolve(input, { scope: 'conversation_turn', relation: 'current', targetId: 'record-a' }), { status: 'unresolved', reason: 'invalid_target' });
  assert.deepEqual(resolve(input, { scope: 'conversation_turn', relation: 'previous', anchorId: 'turn-b', anchorSequence: 1 }), { status: 'unresolved', reason: 'invalid_anchor' });
  assert.deepEqual(resolve(input, { scope: 'conversation_turn', relation: 'offset', anchorId: 'turn-b', offset: 65 }), { status: 'unresolved', reason: 'invalid_offset' });
});
