/** Pi 宿主演示服务：静态页面 + SSE 事件 + chat/confirm 路由。
 * 页面复刻 “Pi 宿主 + IAR 前置意图路由层” 的终端形态，
 * 真实拦截由 @iar/pi-bridge 扩展和 bridge HTTP API 完成，本文件只做协议和边界。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { IarBridgeClientLike } from '@iar/pi-bridge';
import type { SandboxMode } from '../session-types.js';
import { PiHostSession, type PiHostSessionEvents } from './pi-host-session.js';

const DEFAULT_PI_HOST_PORT = 8788;
const HOST = '127.0.0.1';
const MAX_INPUT_LENGTH = 4096;
const MAX_SESSION_ID_LENGTH = 128;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const HEARTBEAT_INTERVAL_MS = 25_000;

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
};

/** 服务句柄；close 释放页面会话与 SSE 连接。 */
export type PiHostServerHandle = { host: string; port: number; mode: SandboxMode; close: () => Promise<void> };

/** SSE 客户端：事件写入与存活状态。 */
type SseClient = { send: (event: string, data: unknown) => void; close: () => void };

/** 构造 Pi 宿主演示应用；路由只做校验和事件转发，处置逻辑都在 PiHostSession。 */
export function buildPiHostApp(options: PiHostServerOptions): { app: FastifyInstance; closeClients: () => void } {
  const pageHtml = options.pageHtml ?? loadPiHostPage();
  const sessions = new Map<string, PiHostSession>();
  const clients = new Map<string, Set<SseClient>>();
  const app = Fastify({ logger: false });

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
    sessionClients.add(client);
    const heartbeat = setInterval(() => { if (!reply.raw.writableEnded) reply.raw.write(': ping\n\n'); }, HEARTBEAT_INTERVAL_MS);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      sessionClients.delete(client);
      if (sessionClients.size === 0) {
        clients.delete(sessionId);
        const session = sessions.get(sessionId);
        sessions.delete(sessionId);
        void session?.dispose();
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

  async function resolveSession(sessionId: string): Promise<PiHostSession> {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const emit = (event: string) => (data: unknown) => { for (const client of clients.get(sessionId) ?? []) client.send(event, data); };
    const events: PiHostSessionEvents = {
      onEntry: emit('entry'),
      onNotify: (message, type) => { for (const client of clients.get(sessionId) ?? []) client.send('notify', { message, type }); },
      onRoute: emit('route'),
      onConfirm: emit('confirm'),
      onPiDelta: emit('piDelta'),
      onPiDone: emit('piDone')
    };
    const session = new PiHostSession({ sessionId, mode: options.mode, ...(options.bridgeUrl === undefined ? {} : { bridgeUrl: options.bridgeUrl }), ...(options.client === undefined ? {} : { client: options.client }), events });
    sessions.set(sessionId, session);
    await session.start();
    return session;
  }

  const closeClients = (): void => {
    for (const sessionClients of clients.values()) for (const client of sessionClients) client.close();
    clients.clear();
  };
  return { app, closeClients };
}

/** 启动 Pi 宿主演示服务并监听本地端口。 */
export async function startPiHostServer(options: PiHostServerOptions): Promise<PiHostServerHandle> {
  const port = options.port ?? readPiHostPort();
  const { app, closeClients } = buildPiHostApp(options);
  await app.listen({ port, host: HOST });
  return { host: HOST, port, mode: options.mode, close: async () => { closeClients(); await app.close(); } };
}

/** 读取页面文件；缺文件或占位符无效时快速失败，避免半可用演示。 */
function loadPiHostPage(): string {
  const html = readFileSync(join(process.cwd(), 'examples', 'agent-sandbox', 'src', 'pi-host', 'web', 'index.html'), 'utf8');
  if (!html.includes('id="transcript"')) throw new Error('Pi 宿主演示页面模板无效。');
  return html;
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

/** 读取普通对象 body，拒绝数组和 null。 */
function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
