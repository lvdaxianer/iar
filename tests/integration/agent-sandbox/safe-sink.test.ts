/**
 * 验证安全日志接收器的异步、有界与故障隔离行为。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as logging from '../../../examples/agent-sandbox/src/safe-log.js';

/** 测试用异步写入回调。 */
type Write = (buffer: Buffer, done: (error: Error | null, written: number) => void) => void;
/** 仅暴露记录入队的接收器。 */
type Sink = { write: (record: Record<string, unknown>) => void };
/**
 * 读取工厂，缺失时必须以行为断言失败，而不是编译失败。
 * 使用反射使 RED 阶段不依赖尚未实现的导出。
 * @returns 限定容量及写入期限的接收器工厂
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function factory(): (write: Write, capacity: number, timeoutMs?: number) => Sink {
  const create: unknown = Reflect.get(logging, 'createSafeLogSink');
  assert.equal(typeof create, 'function', '应提供有界异步安全日志接收器');
  return create as (write: Write, capacity: number, timeoutMs?: number) => Sink;
}
/**
 * 让异步写入调度运行一个事件循环。
 * 使用事件循环边界而非依赖实际外部日志设施。
 * @returns 下一个调度阶段完成的 Promise
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function tick(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }
/** 固定白名单记录，附带不应输出的敏感字段。 */
const record = { level: 'warn', event: 'model.http', secret: 'private-secret' };

/**
 * 写入回调故意不完成，模拟长期缓慢的日志接收器。
 * 入队时不得同步调用写入，队列容量耗尽后应丢弃新记录。
 * 放行第一个写入后，确认实际只写入两条且敏感字段未出现。
 * 该测试不需要创建真实文件或访问模型。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('慢接收器不阻塞并限制队列容量', async () => {
  const writes: Buffer[] = [];
  let complete: ((error: Error | null, written: number) => void) | undefined;
  const sink = factory()((buffer, done) => { writes.push(buffer); complete = done; }, 2);
  sink.write(record);
  sink.write(record);
  sink.write(record);
  // 尚未进入异步阶段时，接收器不能被业务调用直接触发。
  assert.equal(writes.length, 0, '调用路径不得同步写入');
  await tick();
  assert.equal(writes.length, 1, '最多允许一个写入等待完成');
  assert.ok(!writes[0]?.toString().includes('private-secret'));
  complete?.(null, writes[0]!.length);
  await tick();
  assert.equal(writes.length, 2, '容量为二时第三条必须丢弃');
});

/**
 * 第一次只接受五个字节，第二次在续写时报告失败。
 * 失败后部分前缀不可撤销，因此下一条记录必须先写换行。
 * 用拼接后的字节检查分隔符，并拒绝敏感异常和记录字段。
 * 两次调度分别模拟短写及后续记录恢复。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('短写继续并在写错之后用换行恢复记录边界', async () => {
  const output: string[] = [];
  let calls = 0;
  const sink = factory()((buffer, done) => {
    calls += 1;
    // 首次写入只接受前五个字节，模拟短写。
    if (calls === 1) { output.push(buffer.subarray(0, 5).toString()); done(null, 5); return; }
    // 续写阶段失败，下一条记录需要重新分隔。
    if (calls === 2) { done(new Error('private-error'), 0); return; }
    output.push(buffer.toString()); done(null, buffer.length);
  }, 2);
  sink.write(record);
  sink.write(record);
  await tick();
  await tick();
  await tick();
  const text = output.join('');
  assert.ok(text.includes('\n{"level":"warn","event":"model.http"}\n'));
  assert.ok(!text.includes('private-error') && !text.includes('private-secret'));
});

/**
 * 输出失败通过异步回调返回，而不是同步抛出异常。
 * 随后的记录仍必须被提交，且以换行与可能残留的前缀隔开。
 * 检查精确输出，保证接收器恢复不会泄露错误文本。
 * 测试只使用内存接收器，不修改宿主标准输出。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('异步输出失败后下一条记录仍能恢复', async () => {
  const output: string[] = [];
  let calls = 0;
  const sink = factory()((buffer, done) => {
    calls += 1;
    setImmediate(() => {
      // 第一条异步报错，后续记录应恢复输出。
      if (calls === 1) { done(new Error('private-async-error'), 0); return; }
      output.push(buffer.toString());
      done(null, buffer.length);
    });
  }, 2);
  sink.write(record);
  sink.write(record);
  for (let i = 0; i < 5; i += 1) await tick();
  assert.equal(calls, 2);
  assert.equal(output.join(''), '\n{"level":"warn","event":"model.http"}\n');
});

/**
 * 模拟一个在写入期限内永不返回的接收器。
 * 超时必须丢弃排队记录，不能发起第二个同时在途的写入。
 * 原写入回调迟到后再写新记录，验证接收器可以恢复。
 * 十毫秒期限仅用于测试，生产默认期限为一秒。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('卡住的输出超过期限后丢弃等待记录并允许迟到回调后恢复', async () => {
  const writes: Buffer[] = [];
  let complete: ((error: Error | null, written: number) => void) | undefined;
  const sink = factory()((buffer, done) => { writes.push(buffer); complete = done; }, 2, 10);
  sink.write(record);
  await tick();
  sink.write(record);
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  complete?.(null, writes[0]!.length);
  await tick();
  assert.equal(writes.length, 1, '超时后必须丢弃排队记录而不能继续等待');
  sink.write(record);
  await tick();
  assert.equal(writes.length, 2, '迟到回调后应允许新的安全日志恢复输出');
});
