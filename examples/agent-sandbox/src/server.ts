/**
 * 提供 IAR agent sandbox 的 Fastify 宿主服务。
 *
 * 该服务把 IarSandboxSession 暴露为简单的 HTTP API：
 * 聊天（支持 SSE 流式）、确认、压缩、状态和重置，并在 GET / 返回单文件聊天页面。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { loadDotEnv } from './env.js';
import { registerRequestAudit } from './request-audit.js';
import { registerDebugSignal } from './safe-log.js';
import { IarSandboxSession, type SandboxMode } from './session.js';
import { registerSandboxRoutes } from './http-transport.js';
import { SandboxSessionManager, type SandboxSessionLimits } from './session-manager.js';
import { loadSandboxPage } from './page-template.js';
import { createPiAgentDelegate, type PiAgentDelegate } from './models/pi-agent-delegate.js';
import type { SnapshotStore } from '@iar/storage';
import type { SessionPersistenceProvider } from '@iar/storage';
import { loadSandboxPersistenceProvider } from './persistence-provider.js';

/** sandbox 服务的启动配置。 */
export type SandboxServerOptions = {
  /** 大脑模式：brain 真实 LLM，scripted 离线假大脑。 */
  mode: SandboxMode;
  /** 监听端口，缺省取 IAR_SANDBOX_PORT 或 8787。 */
  port?: number;
  /** 独立会话与请求的资源上限。 */
  sessionLimits?: SandboxSessionLimits;
  /** SQLite 文件路径；未注入旧 SnapshotStore 时作为内置 Provider 的路径配置。 */
  snapshotPath?: string;
  /** 测试或宿主注入的快照存储。 */
  snapshotStore?: SnapshotStore;
  /** 可替换的会话持久化 Provider；未提供时加载内置或环境配置 Provider。 */
  persistenceProvider?: SessionPersistenceProvider;
  /** 自定义 Pi 委托工厂；未提供时按模式创建内置进程内 Pi 兜底。 */
  piAgentFactory?: (sessionId: string) => PiAgentDelegate;
};
type ClosableSnapshotStore = SnapshotStore & { close?: () => Promise<void> };
type ClosablePersistenceProvider = SessionPersistenceProvider;
type SandboxStartupResources = {
  snapshotStore?: ClosableSnapshotStore;
  persistenceProvider?: ClosablePersistenceProvider;
  persistenceProviderOpened?: boolean;
  session: IarSandboxSession;
  manager: SandboxSessionManager;
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
  /** 实际使用的会话持久化 Provider。 */
  persistenceProvider?: SessionPersistenceProvider;
  /** 关闭服务并释放会话资源。 */
  close: () => Promise<void>;
};

/** 关闭一旦开始，入口始终拒绝新请求，直到监听器释放。 */
type SandboxLifecycle = { isClosing: boolean; managedClose: boolean };
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
  loadDotEnv();
  let resources: SandboxStartupResources | undefined;
  let app: FastifyInstance | undefined;
  try {
    resources = await createSandboxStartupResources(options);
    const indexHtml = loadSandboxPage();
    app = Fastify({ logger: false });
    const lifecycle: SandboxLifecycle = { isClosing: false, managedClose: false };
    configureSandboxApp(app, { indexHtml, lifecycle, ...resources });
    return await listenSandbox(app, { ...resources, lifecycle, options });
  } catch (error) {
    // 保留启动异常，同时尽力释放已经分配的监听器及工作线程。
    await cleanupFailedStartup({ app, manager: resources?.manager, session: resources?.session, ...(resources?.snapshotStore ? { snapshotStore: resources.snapshotStore } : {}), ...(resources?.persistenceProvider ? { persistenceProvider: resources.persistenceProvider } : {}) });
    throw error;
  }
}

/** 初始化服务共享的 Provider、会话和管理器。 */
async function createSandboxStartupResources(options: SandboxServerOptions): Promise<SandboxStartupResources> {
  const snapshotStore: ClosableSnapshotStore | undefined = options.snapshotStore;
  const persistenceProvider = options.persistenceProvider ?? (!snapshotStore
    ? await loadSandboxPersistenceProvider(options.snapshotPath === undefined ? undefined : { sqlitePath: options.snapshotPath })
    : undefined);
  try {
    if (options.persistenceProvider) await persistenceProvider?.open(undefined);
    const persistenceProviderOpened = persistenceProvider !== undefined;
    const piAgentFactory = options.piAgentFactory ?? ((sessionId: string) => createPiAgentDelegate({ mode: options.mode, sessionId }));
    const session = new IarSandboxSession({ mode: options.mode, sessionId: 'legacy', piAgent: piAgentFactory('legacy'), ...(snapshotStore ? { snapshotStore } : {}), ...(persistenceProvider ? { persistenceProvider, persistenceProviderOpened: true } : {}) });
    return { session, manager: new SandboxSessionManager(options.mode, session, options.sessionLimits, snapshotStore, persistenceProvider, persistenceProviderOpened, piAgentFactory), ...(snapshotStore ? { snapshotStore } : {}), ...(persistenceProvider ? { persistenceProvider, persistenceProviderOpened: true } : {}) };
  } catch (error) {
    try { await persistenceProvider?.close(); } catch { /* 保留原始启动故障。 */ }
    throw error;
  }
}

/** 监听成功后才注册信号，并将同一组资源交给关闭句柄。
 * @param app - 已配置的服务
 * @param context - 会话及生命周期配置
 * @returns 可供调用方关闭的服务句柄
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
async function listenSandbox(app: FastifyInstance, context: { manager: SandboxSessionManager; session: IarSandboxSession; lifecycle: SandboxLifecycle; snapshotStore?: ClosableSnapshotStore; persistenceProvider?: ClosablePersistenceProvider; options: SandboxServerOptions }): Promise<SandboxServerHandle> {
  const { manager, session, lifecycle, snapshotStore, persistenceProvider, options } = context;
  const requestedPort = options.port ?? Number(process.env.IAR_SANDBOX_PORT ?? 8787);
  const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 8787;
  await app.listen({ port, host: '127.0.0.1' });
  const releaseSignal = registerDebugSignal();
  return { app, session, port, mode: options.mode, ...(persistenceProvider ? { persistenceProvider } : {}), close: createSandboxClose(app, manager, snapshotStore, persistenceProvider, { releaseSignal, lifecycle }) };
}

/**
 * 配置统一审计、关闭保护及会话路由。
 * @param app - 新建的 HTTP 服务
 * @param options - 会话管理器、页面和服务生命周期
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function configureSandboxApp(app: FastifyInstance, options: { manager: SandboxSessionManager; indexHtml: string; lifecycle: SandboxLifecycle; snapshotStore?: ClosableSnapshotStore; persistenceProvider?: ClosablePersistenceProvider }): void {
  registerRequestAudit(app);
  registerClosingGuard(app, options.lifecycle);
  registerSandboxRoutes(app, options.manager, options.indexHtml);
  app.addHook('onClose', async () => {
    // server.close() 会在 HTTP 排空后按顺序关闭；外部直接关闭 Fastify 时仍需释放底层 Worker。
    if (options.lifecycle.managedClose) return;
    await options.snapshotStore?.close?.();
    if (options.persistenceProvider !== options.snapshotStore) await options.persistenceProvider?.close();
  });
}

/**
 * 启动失败时尽力释放已分配资源，不覆盖原始启动异常。
 * @param resources - 已分配的服务及会话
 * @returns 清理结束后完成
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function cleanupFailedStartup(resources: { app: FastifyInstance | undefined; manager: SandboxSessionManager | undefined; session: IarSandboxSession | undefined; snapshotStore?: ClosableSnapshotStore; persistenceProvider?: ClosablePersistenceProvider }): Promise<void> {
  try { await resources.app?.close(); } catch { /* 保留原启动故障。 */ }
  try { if (resources.manager) resources.manager.dispose(); else resources.session?.dispose(); } catch { /* 保留原启动故障。 */ }
  try { await resources.snapshotStore?.close?.(); } catch { /* 保留原启动故障。 */ }
  try { if (resources.persistenceProvider !== resources.snapshotStore) await resources.persistenceProvider?.close(); } catch { /* 保留原启动故障。 */ }
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
function createSandboxClose(app: FastifyInstance, manager: SandboxSessionManager, snapshotStore: ClosableSnapshotStore | undefined, persistenceProvider: ClosablePersistenceProvider | undefined, options: { releaseSignal: () => void; lifecycle: SandboxLifecycle }): () => Promise<void> {
  let pending: Promise<void> | undefined;
  let isClosed = false;
  const cleanup = createSandboxCleanup(manager);
  const attempt = async () => {
    // 同步关闭入口，再开始可能失败的异步监听器关闭。
    options.lifecycle.isClosing = true;
    // 信号引用在任何关闭结果下都释放；失败时会话留给在途请求。
    options.lifecycle.managedClose = true;
    try { await app.close(); isClosed = true; } finally { options.lifecycle.managedClose = false; options.releaseSignal(); }
    await manager.drain();
    let failure: unknown;
    try { await manager.flushPersistence(); } catch (error) { failure = error; }
    try { cleanup(); } catch (error) { failure ??= error; }
    try { await snapshotStore?.close?.(); } catch (error) { failure ??= error; }
    try { if (persistenceProvider !== snapshotStore) await persistenceProvider?.close(); } catch (error) { failure ??= error; }
    if (failure !== undefined) throw failure;
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
function createSandboxCleanup(manager: SandboxSessionManager): () => void {
  let isCleaned = false;
  return () => {
    // 即使会话释放失败，也不能再次执行清理。
    if (isCleaned) return;
    isCleaned = true;
    manager.dispose();
  };
}
