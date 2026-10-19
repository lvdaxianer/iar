/**
 * 验证 SSE 序列化和写入故障与客户端断开分别审计。
 * 使用本地可控响应，不记录事件或异常中的敏感哨兵。
 * 测试覆盖同步序列化、同步写入以及异步错误事件。
 * 结束写入失败与客户端主动断开分别检查，避免分类混淆。
 * 异步事件从不同上下文触发时仍须关联原 HTTP 链路。
 * 本地响应模拟仅包含流传输需要的接口与事件监听器。
 * 所有捕获的记录都通过现有安全接收器白名单过滤。
 * 响应模拟不提供额外错误监听，确保真实实现承担监听职责。
 * 同一响应可能先写入失败，再收到重复或迟到的错误事件。
 * 每类失败均验证固定分类与入口链路，不依赖原始异常内容。
 * 已经断开的响应不应被视为新的活动连接写入失败。
 * 夹具在测试完成后恢复进程级日志接收器。
 * 错误先于断开时，即使 destroyed 为真也不能忽略错误。
 * 正常断开之后的迟到错误不会追加新的失败审计。
 * 检查日志内容时使用固定的无真实凭据测试哨兵。
 * 等待写入队列排空，确保断言覆盖异步日志输出。
 * 不让响应中的自由事件和错误对象进入日志记录。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { FastifyReply } from 'fastify';
import { streamTurn } from '../../../examples/agent-sandbox/src/http-stream-transport.js';
import { runWithLogContext } from '../../../examples/agent-sandbox/src/safe-log.js';
import type { IarSandboxSession, StreamEvent } from '../../../examples/agent-sandbox/src/session.js';
import { flushObservabilityLogs, withObservabilityFixture } from './observability-fixture.js';

/** 本地响应操作，可模拟已断开和写入异常。 */
type ReplyOptions = { disconnected?: boolean; failWrite?: boolean; failEnd?: boolean; asyncError?: boolean };
/** 与模拟 HTTP 入口一致的安全链路。 */
const traceId = '15bb85f1-191d-4d7b-b2d7-ea6f01324f6a';

/**
 * 构造只实现流传输所需操作的响应。
 * @param options - 断开与写入异常开关
 * @returns 本地可控 Fastify 响应
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function makeReply(options: ReplyOptions): FastifyReply {
  const raw = Object.assign(new EventEmitter(), { destroyed: Boolean(options.disconnected), writableEnded: false, writeHead: () => {},
    end: () => { if (options.failEnd) throw new Error('private-write-error'); queueMicrotask(() => raw.emit('finish')); },
    destroy: () => { raw.destroyed = true; queueMicrotask(() => raw.emit('close')); },
    write: () => {
      if (options.failWrite) throw new Error('private-write-error');
      if (options.asyncError) queueMicrotask(() => raw.emit('error', new Error('private-write-error')));
    } });
  return { raw, hijack: () => {} } as unknown as FastifyReply;
}

/**
 * 发出指定事件以覆盖流传输的真实回调路径。
 * @param event - 待发出的本地测试事件
 * @returns 模拟会话
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function makeSession(event: StreamEvent): IarSandboxSession {
  return { turnStreamed: async (_message: string, emit: (value: StreamEvent) => void) => { emit(event); } } as unknown as IarSandboxSession;
}

/**
 * 在受控 HTTP 链路下执行流并验证安全失败日志。
 * @param event - 故意触发失败的事件
 * @param options - 可控响应行为
 * @returns 验证结束
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkFailure(event: StreamEvent, options: ReplyOptions): Promise<void> {
  await withObservabilityFixture(async (fixture) => {
    let pending: Promise<void> | undefined;
    runWithLogContext({ traceId }, () => { pending = streamTurn(makeSession(event), 'private-message', makeReply(options)); });
    await pending;
    await flushObservabilityLogs();
    const failure = fixture.records().find((record) => record.outcome === 'stream_write_failed');
    assert.equal(failure?.event, 'http.stream');
    assert.equal(failure?.traceId, traceId);
    assert.doesNotMatch(fixture.lines.join('\n'), /private-write-error|private-event|private-message/);
  });
}

/**
 * 事件序列化异常不能被误当成正常客户端断开。
 * 异常信息和事件内容绝不能进入输出。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('SSE 序列化失败输出安全链路分类', async () => {
  const event = { toJSON: () => { throw new Error('private-event'); } } as unknown as StreamEvent;
  await checkFailure(event, {});
});

/** 活跃连接写入抛错也必须记录固定失败分类。 */
test('SSE 写入失败输出安全链路分类', async () => {
  await checkFailure({ type: 'stage', stage: 'semantic' }, { failWrite: true });
});

/** 结束响应时发生的写入故障也应记录固定分类。 */
test('SSE 结束失败输出安全链路分类', async () => {
  await checkFailure({ type: 'stage', stage: 'semantic' }, { failEnd: true });
});

/** 异步写入错误事件也必须使用安全分类，不泄露异常。 */
test('SSE 异步写入错误输出安全链路分类', async () => {
  await checkFailure({ type: 'stage', stage: 'semantic' }, { asyncError: true });
});

/**
 * 在入口上下文之外触发响应错误，仍应记录原入口链路。
 * 保留单个响应级监听器以安全接收结束后的迟到错误。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('异步写入错误继承入口链路并保留有界监听器', async () => {
  await withObservabilityFixture(async (fixture) => {
    const reply = makeReply({});
    const raw = reply.raw;
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const session = { turnStreamed: async () => { await gate; } } as unknown as IarSandboxSession;
    let pending: Promise<void> | undefined;
    runWithLogContext({ traceId }, () => { pending = streamTurn(session, '', reply); });
    raw.emit('error', new Error('private-write-error'));
    release();
    await pending;
    await flushObservabilityLogs();
    assert.equal(fixture.records().find((entry) => entry.outcome === 'stream_write_failed')?.traceId, traceId);
    assert.equal(raw.listenerCount('error'), 1);
    assert.doesNotMatch(fixture.lines.join('\n'), /private-write-error/);
  });
});

/**
 * 已销毁标志不能覆盖先到的响应写入错误。
 * 多次以及结束后的迟到错误只审计一次，不产生未处理异常。
 * 测试响应本身不安装额外错误监听器。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('销毁状态下的重复和迟到写入错误仅记录一次', async () => {
  await withObservabilityFixture(async (fixture) => {
    const reply = makeReply({});
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const session = { turnStreamed: async () => { await gate; } } as unknown as IarSandboxSession;
    let pending: Promise<void> | undefined;
    runWithLogContext({ traceId }, () => { pending = streamTurn(session, '', reply); });
    Object.defineProperty(reply.raw, 'destroyed', { value: true });
    reply.raw.emit('error', new Error('private-write-error'));
    reply.raw.emit('error', new Error('private-write-error'));
    reply.raw.emit('close'); release(); await pending;
    reply.raw.emit('error', new Error('private-write-error'));
    await flushObservabilityLogs();
    const failures = fixture.records().filter((record) => record.outcome === 'stream_write_failed');
    assert.equal(failures.length, 1); assert.equal(failures[0]?.traceId, traceId);
    assert.doesNotMatch(fixture.lines.join('\n'), /private-write-error/);
  });
});

/**
 * 已经断开的客户端不会被误报为 SSE 写入故障。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('已断开的客户端不触发 SSE 写入故障', async () => {
  await withObservabilityFixture(async (fixture) => {
    const reply = makeReply({ disconnected: true, failWrite: true });
    await streamTurn(makeSession({ type: 'stage', stage: 'semantic' }), 'private-message', reply);
    reply.raw.emit('close');
    reply.raw.emit('error', new Error('private-late-error'));
    reply.raw.emit('error', new Error('private-late-error'));
    await flushObservabilityLogs();
    assert.equal(fixture.records().some((record) => record.outcome === 'stream_write_failed'), false);
    assert.doesNotMatch(fixture.lines.join('\n'), /private-late-error/);
  });
});
