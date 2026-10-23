/**
 * 注册 IAR 面向 Pi 的版本化桥接 HTTP 入口。
 * 路由只转换协议和边界，实际会话、Workflow、PluginHost 仍由 SandboxSessionManager 持有。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BridgeConfirmResponse, BridgeInputResponse, BridgeInputStreamEvent, BridgeOpenRequest, BridgeOpenResponse, BridgePendingAction, BridgeRouteEvidence, BridgeStateResponse } from '@iar/pi-bridge';
import { PI_BRIDGE_VERSION } from '@iar/pi-bridge';
import { readSessionId, type RunOperation } from './http-reservation.js';
import { SandboxSessionManager, SessionError } from './session-manager.js';
import { logBridgeFailure } from './safe-log.js';
import type { IarSandboxSession } from './session.js';
import type { ConfirmResult, RouteEvidence, StreamEvent, TurnResult } from './session-types.js';

const BRIDGE_PREFIX = '/api/bridge/v1';
const MAX_PI_SESSION_ID_LENGTH = 512;
const MAX_BRIDGE_INPUT_LENGTH = 4096;
const ACTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const IAR_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;

/** 注册 Bridge 会话、输入、确认和状态路由。 */
export function registerPiBridgeRoutes(app: FastifyInstance, manager: SandboxSessionManager, run: RunOperation): void {
  const directory = new PiBridgeDirectory(manager);
  app.post(`${BRIDGE_PREFIX}/sessions`, async (request, reply) => handleBridge(reply, async () => {
    const opened = await directory.open(readOpenRequest(request));
    return reply.code(opened.resumed ? 200 : 201).send(opened);
  }));
  app.post(`${BRIDGE_PREFIX}/sessions/:sessionId/input`, async (request, reply) => handleBridge(reply, async () => run(request, 'mutate', (session) => handleInput(session, request, readSessionId(request)!))));
  app.post(`${BRIDGE_PREFIX}/sessions/:sessionId/input/stream`, async (request, reply) => streamInput(request, reply, run));
  app.post(`${BRIDGE_PREFIX}/sessions/:sessionId/confirm`, async (request, reply) => handleBridge(reply, async () => run(request, confirmationOperation(request), (session) => handleConfirmation(session, request, readSessionId(request)!))));
  app.get(`${BRIDGE_PREFIX}/sessions/:sessionId/state`, async (request, reply) => handleBridge(reply, async () => run(request, 'read', (session) => handleState(session, readSessionId(request)!))));
}

/** 打开或恢复 Pi→IAR 的一对一映射。 */
class PiBridgeDirectory {
  private readonly mappings = new Map<string, string>();

  /**
   * 建立或恢复映射。
   * @param request - 已验证的打开请求
   * @returns 映射结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  public async open(request: BridgeOpenRequest): Promise<BridgeOpenResponse> {
    const current = this.mappings.get(request.piSessionId);
    if (current !== undefined && await this.isActive(current)) return { version: PI_BRIDGE_VERSION, piSessionId: request.piSessionId, iarSessionId: current, resumed: true };
    if (request.iarSessionId !== undefined) {
      await this.manager.restore(request.iarSessionId);
      this.mappings.set(request.piSessionId, request.iarSessionId);
      return { version: PI_BRIDGE_VERSION, piSessionId: request.piSessionId, iarSessionId: request.iarSessionId, resumed: true };
    }
    const created = this.manager.create();
    this.mappings.set(request.piSessionId, created);
    return { version: PI_BRIDGE_VERSION, piSessionId: request.piSessionId, iarSessionId: created, resumed: false };
  }

  /**
   * 判断映射的 IAR 会话是否仍可读取。
   * @param sessionId - IAR 会话标识
   * @returns 会话是否可用
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  private async isActive(sessionId: string): Promise<boolean> {
    try { await this.manager.run(sessionId, 'read', async () => undefined); return true; }
    catch (error) {
      if (!(error instanceof SessionError)) throw error;
      return false;
    }
  }

  /**
   * 创建桥接映射目录。
   * @param manager - 共享会话管理器
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  public constructor(private readonly manager: SandboxSessionManager) {}
}

/** 处理输入并把 IAR 结果转成 bridge disposition。 */
async function handleInput(session: IarSandboxSession, request: FastifyRequest, sessionId: string): Promise<BridgeInputResponse> {
  const result = await session.bridgeTurn(readInputText(request));
  return toInputResponse(sessionId, result);
}

/** 以 SSE 暴露最终 response.generate 的 reasoning/answer 增量。 */
async function streamInput(request: FastifyRequest, reply: FastifyReply, run: RunOperation): Promise<void> {
  const sessionId = readSessionId(request);
  if (sessionId === undefined) { await handleBridge(reply, async () => { throw new BridgeRequestError(400, 'invalid_session_id', 'IAR 会话标识无效。'); }); return; }
  let text: string;
  try { text = readInputText(request); } catch (error) { await handleBridge(reply, async () => { throw error; }); return; }
  reply.hijack();
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  try { await run(request, 'mutate', (session) => streamBridgeTurn(session, sessionId, text, reply)); }
  catch (error) { writeBridgeStreamEvent(reply, bridgeStreamError(error)); }
  if (!reply.raw.writableEnded) reply.raw.end();
}

/** 将会话流事件投影为 Bridge 公共 SSE 事件，过滤抽取和路由阶段。 */
async function streamBridgeTurn(session: IarSandboxSession, sessionId: string, text: string, reply: FastifyReply): Promise<void> {
  await session.bridgeTurnStreamed(text, (event) => {
    const projected = projectBridgeStreamEvent(event, sessionId);
    if (projected) writeBridgeStreamEvent(reply, projected);
  });
}

/** 只转发最终回复、计时和终态；semantic.extract 不会进入 reasoning 流。 */
function projectBridgeStreamEvent(event: StreamEvent, sessionId: string): BridgeInputStreamEvent | undefined {
  if (event.type === 'reasoningDelta') return event;
  if (event.type === 'delta') return event;
  if (event.type === 'timing') return { type: 'timing', summary: event.summary };
  if (event.type === 'done') return { type: 'done', result: toInputResponse(sessionId, event.result) };
  return undefined;
}

/** 将 Bridge 错误投影成稳定 SSE 错误事件，不传播异常正文。 */
function bridgeStreamError(error: unknown): BridgeInputStreamEvent {
  logBridgeFailure(classifyBridgeFailure(error));
  if (error instanceof BridgeRequestError) return { type: 'error', code: error.code, message: error.message, retryable: false };
  if (error instanceof SessionError) return { type: 'error', code: error.reasonCode, message: 'IAR 会话请求未完成。', retryable: error.status >= 500 || error.status === 429 };
  return { type: 'error', code: 'bridge_internal_error', message: 'IAR 桥接请求未完成。', retryable: true };
}

/** 向仍开放的 SSE 响应写入一条 JSON 事件。 */
function writeBridgeStreamEvent(reply: FastifyReply, event: BridgeInputStreamEvent): void {
  if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** 处理确认或取消，动作范围只从 IAR 当前 pending 读取。 */
async function handleConfirmation(session: IarSandboxSession, request: FastifyRequest, sessionId: string): Promise<BridgeConfirmResponse> {
  const body = readRecord(request.body);
  const result = await session.confirm(body.accepted as boolean);
  return toConfirmResponse(sessionId, result);
}

/** 返回当前 IAR 会话的最小待确认状态。 */
async function handleState(session: IarSandboxSession, sessionId: string): Promise<BridgeStateResponse> {
  const state = await session.state();
  return { version: PI_BRIDGE_VERSION, iarSessionId: sessionId, ...(state.pending === null ? {} : { pending: toPendingAction(state.pending) }) };
}

/** 将 IAR TurnResult 转成公开输入 response。 */
function toInputResponse(sessionId: string, result: TurnResult): BridgeInputResponse {
  const timing = result.timing === undefined ? {} : { timing: result.timing };
  if (result.status === 'pass_through') return { version: PI_BRIDGE_VERSION, iarSessionId: sessionId, disposition: 'pass_through', route: toRouteEvidence(result.route), capabilityContext: result.capabilityContext, replySource: result.replySource ?? 'pi_agent', ...timing };
  if (result.status === 'awaiting_confirmation') return { version: PI_BRIDGE_VERSION, iarSessionId: sessionId, disposition: 'awaiting_confirmation', reply: result.reply, pending: toPendingAction(result.pending), route: toRouteEvidence(result.route), replySource: result.replySource ?? 'none', ...timing };
  if (result.status === 'clarification') return { version: PI_BRIDGE_VERSION, iarSessionId: sessionId, disposition: result.disposition ?? 'clarification', reply: result.reply, reasonCode: result.reasonCode, route: toRouteEvidence(result.route), replySource: result.replySource ?? 'response_model', ...timing };
  if (result.status === 'executed') return { version: PI_BRIDGE_VERSION, iarSessionId: sessionId, disposition: 'handled', reply: result.reply, ...(result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode }), route: toRouteEvidence(result.route), replySource: result.replySource ?? 'response_model', ...timing };
  if (result.status === 'failed') return { version: PI_BRIDGE_VERSION, iarSessionId: sessionId, disposition: 'handled', reply: result.reply, reasonCode: result.reasonCode, route: toRouteEvidence(result.route), replySource: result.replySource ?? 'none', ...timing };
  // bridge 会话不挂载进程内 Pi 委托，agent 终态只出现在网页会话，属于协议不变量破坏。
  throw new BridgeRequestError(500, 'unexpected_agent_disposition', 'IAR 桥接结果异常。');
}

/** 将确认结果转成 handled response。 */
function toConfirmResponse(sessionId: string, result: ConfirmResult): BridgeConfirmResponse {
  if (result.status === 'failed') return { version: PI_BRIDGE_VERSION, iarSessionId: sessionId, disposition: 'handled', reply: result.reply, reasonCode: result.reasonCode, replySource: result.replySource ?? 'none' };
  return { version: PI_BRIDGE_VERSION, iarSessionId: sessionId, disposition: 'handled', reply: result.reply, replySource: result.replySource ?? 'response_model' };
}

/** 只公开路由摘要，禁止暴露模型和 Action 输入。 */
function toRouteEvidence(route: RouteEvidence): BridgeRouteEvidence {
  return { status: route.status, reasonCode: route.reasonCode, semanticIntent: route.semanticIntent, semanticConfidence: route.semanticConfidence, ...(route.functionId === undefined ? {} : { functionId: route.functionId }), ...(route.pluginId === undefined ? {} : { pluginId: route.pluginId }), ...(route.operationKind === undefined ? {} : { operationKind: route.operationKind }), ...(route.expectedOperation === undefined ? {} : { expectedOperation: route.expectedOperation }), ...(route.actualOperation === undefined ? {} : { actualOperation: route.actualOperation }) };
}

/** 从公开 pending 摘要去除 Action input。 */
function toPendingAction(pending: { actionId: string; runId: string; functionId: string; pluginId: string; riskLevel: string; confirmationRequired: boolean }): BridgePendingAction {
  return { actionId: pending.actionId, runId: pending.runId, functionId: pending.functionId, pluginId: pending.pluginId, riskLevel: pending.riskLevel, confirmationRequired: pending.confirmationRequired };
}

/** 读取并验证打开请求。 */
function readOpenRequest(request: FastifyRequest): BridgeOpenRequest {
  const body = readRecord(request.body);
  if (!isBoundedString(body.piSessionId, MAX_PI_SESSION_ID_LENGTH)) throw new BridgeRequestError(400, 'invalid_pi_session_id', 'Pi 会话标识无效。');
  if (body.iarSessionId !== undefined && (typeof body.iarSessionId !== 'string' || !IAR_SESSION_ID_PATTERN.test(body.iarSessionId))) throw new BridgeRequestError(400, 'invalid_iar_session_id', 'IAR 会话标识无效。');
  return { piSessionId: body.piSessionId, ...(body.iarSessionId === undefined ? {} : { iarSessionId: body.iarSessionId as string }) };
}

/** 读取并验证 bridge 输入正文。 */
function readInputText(request: FastifyRequest): string {
  const body = readRecord(request.body);
  if (typeof body.text !== 'string' || body.text.length === 0) throw new BridgeRequestError(400, 'invalid_bridge_input', '桥接输入无效。');
  if (body.text.length > MAX_BRIDGE_INPUT_LENGTH) throw new BridgeRequestError(413, 'bridge_input_too_large', '桥接输入无效。');
  const text = body.text.trim();
  if (text.length === 0) throw new BridgeRequestError(400, 'invalid_bridge_input', '桥接输入无效。');
  return text;
}

/** 读取确认正文，复用会话管理器的 actionId 冲突校验。 */
function confirmationOperation(request: FastifyRequest): { kind: 'confirm' | 'cancel'; actionId: unknown; accepted: unknown } {
  const body = readRecord(request.body);
  if (typeof body.accepted !== 'boolean') throw new BridgeRequestError(400, 'invalid_accepted', '确认选择无效。');
  if (typeof body.actionId !== 'string' || !ACTION_ID_PATTERN.test(body.actionId)) throw new BridgeRequestError(400, 'invalid_action_id', '动作标识无效。');
  return { kind: 'confirm', actionId: body.actionId, accepted: body.accepted };
}

/** 处理 bridge 路由异常并返回稳定错误。 */
async function handleBridge(reply: FastifyReply, action: () => Promise<unknown>): Promise<unknown> {
  try { return await action(); }
  catch (error) {
    logBridgeFailure(classifyBridgeFailure(error));
    if (error instanceof BridgeRequestError) return reply.code(error.status).send({ version: PI_BRIDGE_VERSION, code: error.code, message: error.message, retryable: false });
    if (error instanceof SessionError) return reply.code(error.status).send({ version: PI_BRIDGE_VERSION, code: error.reasonCode, message: 'IAR 会话请求未完成。', retryable: error.status >= 500 || error.status === 429 });
    return reply.code(500).send({ version: PI_BRIDGE_VERSION, code: 'bridge_internal_error', message: 'IAR 桥接请求未完成。', retryable: true });
  }
}

/**
 * 将桥接异常归并为有限、可检索且不暴露异常正文的原因码。
 *
 * @param error - 桥接层捕获的未知异常
 * @returns 稳定的桥接错误原因码
 * @author lvdaxianer@yeah.net
 * @date 2026-10-23
 */
function classifyBridgeFailure(error: unknown): 'bridge_timeout' | 'bridge_unavailable' | 'bridge_request_invalid' | 'bridge_session_failed' | 'bridge_internal_error' {
  if (error instanceof BridgeRequestError) return 'bridge_request_invalid';
  if (error instanceof SessionError) {
    if (error.status === 408 || error.status === 504 || error.reasonCode === 'request_timeout') return 'bridge_timeout';
    if (error.status >= 500) return 'bridge_unavailable';
    return 'bridge_session_failed';
  }
  return 'bridge_internal_error';
}

/** Bridge 请求校验错误。 */
class BridgeRequestError extends Error {
  /** @param status - HTTP 状态码 @param code - 稳定错误码 @param message - 安全提示 @author lvdaxianer@yeah.net @date 2026-10-20 */
  public constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

/** 读取普通对象 body，拒绝数组和 null。 */
function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 检查非空且不超过上限的字符串。 */
function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}
