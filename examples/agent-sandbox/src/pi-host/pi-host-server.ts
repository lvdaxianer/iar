/** Pi 宿主演示服务：静态页面 + SSE 事件 + chat/confirm 路由。
 * 页面与 IAR Agent Sandbox 共用样式与安全 Markdown 片段，仅协议适配不同，
 * 真实拦截由 @iar/pi-bridge 扩展和 bridge HTTP API 完成，本文件只做协议和边界。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { IarBridgeClientLike } from '@iar/pi-bridge';
import type { SandboxMode } from '../session-types.js';
import { loadPiHostPage } from '../page-template.js';
import { PiHostSession, type PiHostSessionEvents } from './pi-host-session.js';

const DEFAULT_PI_HOST_PORT = 8788;
const HOST = '127.0.0.1';
const MAX_INPUT_LENGTH = 4096;
const MAX_SESSION_ID_LENGTH = 128;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const HEARTBEAT_INTERVAL_MS = 25_000;
const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;

/** Pi 宿主演示服务配置。 */
export type PiHostServerOptions = {
  /** 监听端口；缺省 IAR_PI_HOST_PORT 或 8788。 */
  port?: number;
  /** Pi Agent 大脑模式。 */
  mode: SandboxMode;
  /** bridge 地址；缺省 IAR_PI_BRIDGE_URL 或本地 8787。 */
  bridgeUrl?: string;
  /** 覆盖 bridge client（测试注入假桥）。 */
  client?: IarBridgeClientLike;
  /** 覆盖页面 HTML（测试注入）。 */
  pageHtml?: string;
  /** Pi Host 会话无客户端时的最大空闲时间；缺省 30 分钟。 */
  sessionIdleMs?: number;
};

/** 服务句柄；close 释放页面会话与 SSE 连接。 */
export type PiHostServerHandle = { host: string; port: number; mode: SandboxMode; close: () => Promise<void> };

/** SSE 客户端：事件写入与存活状态。 */
type SseClient = { send: (event: string, data: unknown) => void; close: () => void };
/** Pi Host 会话条目；连接断开后仍保留到空闲回收或显式清空。 */
type PiHostSessionEntry = { session: PiHostSession; lastUsedAt: number };

/** 构造 Pi 宿主演示应用；路由只做校验和事件转发，处置逻辑都在 PiHostSession。 */
export function buildPiHostApp(options: PiHostServerOptions): { app: FastifyInstance; closeClients: () => Promise<void> } {
  const pageHtml = options.pageHtml ?? loadPiHostPage();
  const sessionIdleMs = validateSessionIdleMs(options.sessionIdleMs);
  const sessions = new Map<string, PiHostSessionEntry>();
  const clients = new Map<string, Set<SseClient>>();
  const app = Fastify({ logger: false });
  const sweepTimer = setInterval(sweepSessions, Math.min(sessionIdleMs, 60_000));
  sweepTimer.unref();

  app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(pageHtml));

  app.get('/api/pi-host/events', async (request, reply) => {
    const sessionId = readSessionId(request);
    if (sessionId === undefined) return reply.code(400).send({ error: 'invalid_session' });
    const sessionClients = clients.get(sessionId) ?? new Set<SseClient>();
    clients.set(sessionId, sessionClients);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ sessionId, mode: options.mode, bridgeUrl: options.bridgeUrl ?? process.env.IAR_PI_BRIDGE_URL ?? 'http://127.0.0.1:8787' })}\n\n`);
    const client: SseClient = {
      send: (event, data) => { if (!reply.raw.writableEnded) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); },
      close: () => { if (!reply.raw.writableEnded) reply.raw.end(); }
    };
    sweepSessions();
    sessionClients.add(client);
    const existing = sessions.get(sessionId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      client.send('confirm', existing.session.pendingConfirmation());
    } else {
      client.send('confirm', null);
    }
    const heartbeat = setInterval(() => { if (!reply.raw.writableEnded) reply.raw.write(': ping\n\n'); }, HEARTBEAT_INTERVAL_MS);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      sessionClients.delete(client);
      if (sessionClients.size === 0) {
        clients.delete(sessionId);
      }
    });
    // SSE 路由由连接生命周期驱动，不通过返回值结束响应。
    await new Promise<void>((resolve) => { reply.raw.on('close', resolve); });
  });

  app.post('/api/pi-host/chat', async (request, reply) => {
    const body = readRecord(request.body);
    const sessionId = typeof body.session === 'string' ? body.session : undefined;
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (sessionId === undefined || !SESSION_ID_PATTERN.test(sessionId)) return reply.code(400).send({ error: 'invalid_session' });
    if (text.length === 0 || text.length > MAX_INPUT_LENGTH) return reply.code(400).send({ error: 'invalid_input' });
    const session = await resolveSession(sessionId);
    const result = await session.handleUserInput(text);
    return reply.send(result);
  });

  app.post('/api/pi-host/confirm', async (request, reply) => {
    const body = readRecord(request.body);
    const sessionId = typeof body.session === 'string' ? body.session : undefined;
    if (sessionId === undefined || !SESSION_ID_PATTERN.test(sessionId)) return reply.code(400).send({ error: 'invalid_session' });
    if (typeof body.accepted !== 'boolean') return reply.code(400).send({ error: 'invalid_accepted' });
    const session = await resolveSession(sessionId);
    const ok = await session.confirm(body.accepted);
    return reply.send({ ok });
  });

  app.delete('/api/pi-host/session/:sessionId', async (request, reply) => {
    const sessionId = readPathSessionId(request);
    if (sessionId === undefined) return reply.code(400).send({ error: 'invalid_session' });
    await disposeSession(sessionId);
    return reply.send({ ok: true });
  });

  async function resolveSession(sessionId: string): Promise<PiHostSession> {
    sweepSessions();
    const existing = sessions.get(sessionId);
    if (existing) { existing.lastUsedAt = Date.now(); return existing.session; }
    const emit = (event: string) => (data: unknown) => { for (const client of clients.get(sessionId) ?? []) client.send(event, data); };
    const events: PiHostSessionEvents = {
      onEntry: emit('entry'),
      onNotify: (message, type) => { for (const client of clients.get(sessionId) ?? []) client.send('notify', { message, type }); },
      onRoute: emit('route'),
      onTiming: emit('timing'),
      onConfirm: emit('confirm'),
      onPiDelta: emit('piDelta'),
      onPiDone: emit('piDone'),
      onIarReasoningDelta: emit('iarReasoningDelta'),
      onIarDelta: emit('iarDelta')
    };
    const session = new PiHostSession({ sessionId, mode: options.mode, ...(options.bridgeUrl === undefined ? {} : { bridgeUrl: options.bridgeUrl }), ...(options.client === undefined ? {} : { client: options.client }), events });
    sessions.set(sessionId, { session, lastUsedAt: Date.now() });
    await session.start();
    return session;
  }

  const closeClients = async (): Promise<void> => {
    clearInterval(sweepTimer);
    for (const sessionClients of clients.values()) for (const client of sessionClients) client.close();
    clients.clear();
    const disposals = [...sessions.values()].map((entry) => entry.session.dispose());
    sessions.clear();
    await Promise.all(disposals);
  };

  /**
   * 回收没有 SSE 客户端且已经超时的 Pi Host 会话。
   *
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-24
   */
  function sweepSessions(): void {
    const threshold = Date.now() - sessionIdleMs;
    for (const [sessionId, entry] of sessions) {
      if (entry.lastUsedAt < threshold && (clients.get(sessionId)?.size ?? 0) === 0) void disposeSession(sessionId);
    }
  }

  /**
   * 释放指定会话及其 SSE 客户端；未知会话按幂等成功处理。
   *
   * @param sessionId - 要释放的 Pi Host 会话标识
   * @returns 会话资源释放完成后的 Promise
   * @author lvdaxianer@yeah.net
   * @date 2026-10-24
   */
  async function disposeSession(sessionId: string): Promise<void> {
    const entry = sessions.get(sessionId);
    sessions.delete(sessionId);
    for (const client of clients.get(sessionId) ?? []) client.close();
    clients.delete(sessionId);
    await entry?.session.dispose();
  }
  return { app, closeClients };
}

/** 启动 Pi 宿主演示服务并监听本地端口。 */
export async function startPiHostServer(options: PiHostServerOptions): Promise<PiHostServerHandle> {
  const port = options.port ?? readPiHostPort();
  const { app, closeClients } = buildPiHostApp(options);
  await app.listen({ port, host: HOST });
  return { host: HOST, port, mode: options.mode, close: async () => { await closeClients(); await app.close(); } };
}

/** 读取可配置端口；非法值不可静默回退。 */
function readPiHostPort(): number {
  const raw = process.env.IAR_PI_HOST_PORT;
  if (raw === undefined || raw.length === 0) return DEFAULT_PI_HOST_PORT;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 65535) throw new Error('IAR_PI_HOST_PORT 必须是 1-65535 的整数。');
  return value;
}

/** 读取会话标识查询参数。 */
function readSessionId(request: FastifyRequest): string | undefined {
  const value = (request.query as Record<string, unknown>).session;
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SESSION_ID_LENGTH ? value : undefined;
}

/**
 * 读取并校验 DELETE 路由中的 Pi Host 会话标识。
 *
 * @param request - Fastify 路由请求
 * @returns 合法会话标识或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
function readPathSessionId(request: FastifyRequest): string | undefined {
  const value = (request.params as Record<string, unknown>).sessionId;
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value) ? value : undefined;
}

/**
 * 校验会话空闲时间配置，拒绝可能造成永不回收或立即抖动的值。
 *
 * @param value - 可选空闲时间，单位为毫秒
 * @returns 生效的正整数空闲时间
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
function validateSessionIdleMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SESSION_IDLE_MS;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('sessionIdleMs 必须是正整数。');
  return value;
}

/** 读取普通对象 body，拒绝数组和 null。 */
function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
