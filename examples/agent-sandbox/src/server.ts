/**
 * 提供 IAR agent sandbox 的 Fastify 宿主服务。
 *
 * 该服务把 IarSandboxSession 暴露为简单的 HTTP API：
 * 聊天（支持 SSE 流式）、确认、压缩、状态和重置，并在 GET / 返回单文件聊天页面。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { loadDotEnv } from './env.js';
import { IarSandboxSession, type SandboxMode, type StreamEvent } from './session.js';

/** sandbox 服务的启动配置。 */
export type SandboxServerOptions = {
  /** 大脑模式：brain 真实 LLM，scripted 离线假大脑。 */
  mode: SandboxMode;
  /** 监听端口，缺省取 IAR_SANDBOX_PORT 或 8787。 */
  port?: number;
};

/** 已启动的 sandbox 服务句柄。 */
export type SandboxServerHandle = {
  /** Fastify 实例。 */
  app: FastifyInstance;
  /** 会话组合根。 */
  session: IarSandboxSession;
  /** 实际监听端口。 */
  port: number;
  /** 启动模式。 */
  mode: SandboxMode;
  /** 关闭服务并释放会话资源。 */
  close: () => Promise<void>;
};

/**
 * 创建 Fastify 实例、注册路由并启动监听。
 *
 * @param options - 模式和端口配置
 * @returns 服务句柄
 * @throws Error 当端口占用或会话初始化失败
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export async function startSandboxServer(options: SandboxServerOptions): Promise<SandboxServerHandle> {
  // 先补齐 .env 中的环境变量，再初始化会话，保证 provider 能读到密钥。
  loadDotEnv();
  const session = new IarSandboxSession({ mode: options.mode });
  // 启动时缓存单文件页面，避免每次请求重复读盘。
  const indexHtml = readFileSync(join(process.cwd(), 'examples', 'agent-sandbox', 'web', 'index.html'), 'utf8');
  const app = Fastify({ logger: false });

  app.get('/', async (_request, reply) => {
    void reply.type('text/html; charset=utf-8');
    return indexHtml;
  });

  app.post('/api/chat', async (request, reply) => {
    const body = asRecord(request.body);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (message.length === 0) {
      return { status: 'failed', reply: '消息不能为空。', reasonCode: 'empty_message' };
    }
    if (!wantsStream(request, body)) return session.turn(message);
    return streamTurn(session, message, reply);
  });

  app.post('/api/confirm', async (request) => {
    const body = asRecord(request.body);
    return session.confirm(body.accepted === true);
  });

  app.post('/api/compact', async () => session.compact());

  app.get('/api/state', async () => session.state());

  app.post('/api/reset', async () => {
    await session.reset();
    return { ok: true };
  });

  const requestedPort = options.port ?? Number(process.env.IAR_SANDBOX_PORT ?? 8787);
  const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 8787;
  await app.listen({ port, host: '127.0.0.1' });
  const modeLabel = options.mode === 'brain' ? 'brain real（真实 LLM）' : 'brain scripted（离线假大脑）';
  console.log(`IAR agent sandbox 已启动：http://localhost:${String(port)} （模式: ${modeLabel}）`);
  return {
    app,
    session,
    port,
    mode: options.mode,
    close: async () => {
      await app.close();
      session.dispose();
    }
  };
}

/**
 * 把未知请求体收窄为普通对象。
 *
 * @param value - 未知请求体
 * @returns 普通对象或空对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * 判断本次聊天请求是否要求流式响应。
 *
 * @param request - Fastify 请求（读取查询参数）
 * @param body - 已收窄的请求体
 * @returns 是否走 SSE 流式
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function wantsStream(request: FastifyRequest, body: Record<string, unknown>): boolean {
  if (body.stream === true) return true;
  const query = asRecord(request.query);
  return query.stream === '1' || query.stream === 'true';
}

/**
 * 执行一轮流式对话并通过 reply.raw 下发 SSE 事件。
 *
 * 事件序列为若干 stage/delta/done，结束时固定发送 `{"type":"end"}` 并关闭连接；
 * 处理异常时发送 error 事件而不是让连接裸断。hijack 之后由本函数全权负责响应写入。
 *
 * @param session - 会话组合根
 * @param message - 用户消息
 * @param reply - Fastify 回复对象（接管底层响应）
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function streamTurn(session: IarSandboxSession, message: string, reply: FastifyReply): Promise<void> {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  const emit = (event: StreamEvent): void => {
    try {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // 客户端提前断开时静默丢弃，避免写入异常冒泡。
    }
  };
  try {
    await session.turnStreamed(message, emit);
  } catch {
    emit({ type: 'error', reasonCode: 'stream_failed', message: '流式处理失败，请重试。' });
  }
  try {
    if (!reply.raw.writableEnded) {
      reply.raw.write('data: {"type":"end"}\n\n');
      reply.raw.end();
    }
  } catch {
    // 客户端提前断开时结束流程。
  }
}
