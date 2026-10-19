/**
 * 将沙箱流式对话写入 SSE 响应。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import type { FastifyReply } from 'fastify';
import { AsyncResource } from 'node:async_hooks';
import type { IarSandboxSession, StreamEvent } from './session.js';
import { logStreamFailure } from './safe-log.js';
import { auditStreamWriteFailure } from './request-audit.js';

/** 单个响应的有界终态，重复或迟到错误不会重复审计。 */
type StreamState = { isFailed: boolean; isDisconnected: boolean; isFinished: boolean };
/** 响应结束迟迟未完成时主动断开，避免慢客户端无限持有会话。 */
const STREAM_END_TIMEOUT_MS = 10_000;

/**
 * 执行流式对话并保持已有 SSE 事件契约。
 *
 * @param session - 沙箱会话
 * @param message - 用户消息
 * @param reply - Fastify 响应
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export async function streamTurn(session: IarSandboxSession, message: string, reply: FastifyReply): Promise<void> {
  reply.hijack();
  const state = watchStreamErrors(reply);
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  try {
    await session.turnStreamed(message, (event) => emitEvent(reply, event, state));
  } catch {
    // 会话失败时向客户端发送既有的安全错误码。
    logStreamFailure();
    emitEvent(reply, { type: 'error', reasonCode: 'stream_failed', message: '流式处理失败，请重试。' }, state);
  }
  const finished = waitForStreamEnd(reply);
  finishStream(reply, state);
  await finished;
}

/** 响应结束或断开后释放队列；慢客户端不能无限持有会话。
 * 定时断开及正常结束都移除监听器并清除定时器。
 * @param reply - 当前 SSE 响应
 * @returns 响应结束、断开或超时后完成
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
function waitForStreamEnd(reply: FastifyReply): Promise<void> {
  const raw = reply.raw;
  if (raw.destroyed || raw.writableFinished) return Promise.resolve();
  return new Promise((resolve) => {
    const complete = () => { clearTimeout(timer); raw.off('finish', complete); raw.off('close', complete); resolve(); };
    const timer = setTimeout(() => { raw.destroy(); complete(); }, STREAM_END_TIMEOUT_MS);
    timer.unref();
    raw.once('finish', complete); raw.once('close', complete);
  });
}

/**
 * 监听异步写入错误并绑定入口链路；响应持有一个错误监听器直至回收。
 * @param reply - Fastify 响应
 * @returns 当前响应的单次终态
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function watchStreamErrors(reply: FastifyReply): StreamState {
  const raw = reply.raw;
  const state = { isFailed: false, isDisconnected: raw.destroyed, isFinished: false };
  // 保留有界的响应级错误监听器，防止结束后的迟到 error 变成未处理异常。
  // 必须先于 Fastify 的错误监听器归因，后者可能立即触发 onResponse。
  raw.prependListener('error', AsyncResource.bind(() => failStream(reply, state)));
  const cleanup = () => { raw.off('finish', onFinish); raw.off('close', onClose); };
  const onFinish = () => { state.isFinished = true; cleanup(); };
  const onClose = () => { state.isDisconnected = true; cleanup(); };
  raw.once('finish', onFinish); raw.once('close', onClose);
  return state;
}

/**
 * 仅在断开或正常结束之前记录首次写入故障。
 * @param reply - 当前响应
 * @param state - 响应终态
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function failStream(reply: FastifyReply, state: StreamState): void {
  if (state.isFailed || state.isDisconnected || state.isFinished) return;
  state.isFailed = true;
  if (auditStreamWriteFailure(reply.raw)) logStreamFailure('stream_write_failed');
}

/**
 * 将单个事件写入仍然开放的 SSE 连接。
 *
 * @param reply - Fastify 响应
 * @param event - 流式事件
 * @param state - 响应终态
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function emitEvent(reply: FastifyReply, event: StreamEvent, state: StreamState): void {
  try {
    // 客户端已断开时无需继续写入。
    if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch {
    // 活跃连接的序列化或写入故障只记录固定分类，不保留异常或事件。
    failStream(reply, state);
  }
}

/**
 * 写入结束事件并关闭仍然开放的 SSE 连接。
 *
 * @param reply - Fastify 响应
 * @param state - 响应终态
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function finishStream(reply: FastifyReply, state: StreamState): void {
  try {
    // 仅在连接可写时发送结束标识。
    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      reply.raw.write('data: {"type":"end"}\n\n');
      reply.raw.end();
    }
  } catch {
    // 客户端断开由入口审计；其他失败以固定分类记录。
    failStream(reply, state);
    reply.raw.destroy();
  }
}
