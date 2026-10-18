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
import Fastify, { type FastifyInstance } from 'fastify';
import { loadDotEnv } from './env.js';
import { registerRequestAudit } from './request-audit.js';
import { registerDebugSignal } from './safe-log.js';
import { IarSandboxSession, type SandboxMode } from './session.js';
import { registerSandboxRoutes } from './http-transport.js';

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

/** 关闭一旦开始，入口始终拒绝新请求，直到监听器释放。 */
type SandboxLifecycle = { isClosing: boolean };
/** 不暴露内部故障的统一关闭响应。 */
const CLOSING_STATUS = 503;

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
  const indexHtml = readFileSync(join(process.cwd(), 'examples', 'agent-sandbox', 'web', 'index.html'), 'utf8');
  const app = Fastify({ logger: false });
  registerRequestAudit(app);
  const lifecycle: SandboxLifecycle = { isClosing: false };
  registerClosingGuard(app, lifecycle);
  registerSandboxRoutes(app, session, indexHtml);
  const requestedPort = options.port ?? Number(process.env.IAR_SANDBOX_PORT ?? 8787);
  const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 8787;
  await app.listen({ port, host: '127.0.0.1' });
  const releaseDebugSignal = registerDebugSignal();
  return { app, session, port, mode: options.mode,
    close: createSandboxClose(app, session, { releaseSignal: releaseDebugSignal, lifecycle }) };
}

/**
 * 在统一请求审计之后拒绝关闭期间进入的所有 HTTP 请求。
 * @param app - 已注册审计的沙箱服务
 * @param lifecycle - 本服务的关闭状态
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function registerClosingGuard(app: FastifyInstance, lifecycle: SandboxLifecycle): void {
  app.addHook('onRequest', (_request, reply, done) => {
    // 会话可能已释放，关闭开始后不得再进入任何业务路由。
    if (lifecycle.isClosing) void reply.code(CLOSING_STATUS).send({ status: 'failed', reasonCode: 'sandbox_closing' });
    else done();
  });
}

/**
 * 并发关闭共享尝试；失败保留会话，底层关闭成功后才释放会话。
 * @param app - 已启动的 Fastify 实例
 * @param session - 已启动的会话
 * @param options - 信号释放函数与入口关闭状态
 * @returns 幂等关闭函数
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function createSandboxClose(app: FastifyInstance, session: IarSandboxSession, options: { releaseSignal: () => void; lifecycle: SandboxLifecycle }): () => Promise<void> {
  let pending: Promise<void> | undefined;
  let isClosed = false;
  const cleanup = createSandboxCleanup(session);
  const attempt = async () => {
    // 同步关闭入口，再开始可能失败的异步监听器关闭。
    options.lifecycle.isClosing = true;
    // 信号引用在任何关闭结果下都释放；失败时会话留给在途请求。
    try { await app.close(); isClosed = true; } finally { options.releaseSignal(); }
    cleanup();
  };
  return () => pending ??= attempt().catch((error: unknown) => {
    // 只有底层关闭未完成时才允许重新尝试。
    if (!isClosed) pending = undefined;
    throw error;
  });
}

/**
 * 创建至多执行一次的会话清理函数。
 * @param session - 已启动的会话
 * @returns 幂等清理函数
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function createSandboxCleanup(session: IarSandboxSession): () => void {
  let isCleaned = false;
  return () => {
    // 即使会话释放失败，也不能再次执行清理。
    if (isCleaned) return;
    isCleaned = true;
    session.dispose();
  };
}
