/**
 * 提供 IAR agent sandbox 的 Fastify 宿主服务。
 *
 * 该服务把 IarSandboxSession 暴露为简单的 HTTP API：
 * 聊天、确认、压缩、状态和重置，并在 GET / 返回单文件聊天页面。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadDotEnv } from './env.js';
import { IarSandboxSession, type SandboxMode } from './session.js';

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

  app.post('/api/chat', async (request) => {
    const body = asRecord(request.body);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (message.length === 0) {
      return { status: 'failed', reply: '消息不能为空。', reasonCode: 'empty_message' };
    }
    return session.turn(message);
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
