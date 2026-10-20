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
