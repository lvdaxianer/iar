/**
 * 注册 IAR 面向 Pi 的版本化桥接 HTTP 入口。
 * 路由只转换协议和边界，实际会话、Workflow、PluginHost 仍由 SandboxSessionManager 持有。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BridgeConfirmResponse, BridgeInputResponse, BridgeOpenRequest, BridgeOpenResponse, BridgePendingAction, BridgeRouteEvidence, BridgeStateResponse } from '@iar/pi-bridge';
import { PI_BRIDGE_VERSION } from '@iar/pi-bridge';
import { readSessionId, type RunOperation } from './http-reservation.js';
import { SandboxSessionManager, SessionError } from './session-manager.js';
import type { IarSandboxSession } from './session.js';
import type { ConfirmResult, RouteEvidence, TurnResult } from './session-types.js';

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
  if (result.status === 'pass_through') return { version: PI_BRIDGE_VERSION, iarSessionId: sessionId, disposition: 'pass_through', route: toRouteEvidence(result.route) };
  if (result.status === 'awaiting_confirmation') return { version: PI_BRIDGE_VERSION, iarSessionId: sessionId, disposition: 'awaiting_confirmation', reply: result.reply, pending: toPendingAction(result.pending), route: toRouteEvidence(result.route) };
  if (result.status === 'clarification') return { version: PI_BRIDGE_VERSION, iarSessionId: sessionId, disposition: 'clarification', reply: result.reply, reasonCode: result.reasonCode, route: toRouteEvidence(result.route) };
  if (result.status === 'executed') return { version: PI_BRIDGE_VERSION, iarSessionId: sessionId, disposition: 'handled', reply: result.reply, ...(result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode }), route: toRouteEvidence(result.route) };
  if (result.status === 'failed') return { version: PI_BRIDGE_VERSION, iarSessionId: sessionId, disposition: 'handled', reply: result.reply, reasonCode: result.reasonCode, route: toRouteEvidence(result.route) };
  // bridge 会话不挂载进程内 Pi 委托，agent 终态只出现在网页会话，属于协议不变量破坏。
  throw new BridgeRequestError(500, 'unexpected_agent_disposition', 'IAR 桥接结果异常。');
}

/** 将确认结果转成 handled response。 */
function toConfirmResponse(sessionId: string, result: ConfirmResult): BridgeConfirmResponse {
  if (result.status === 'failed') return { version: PI_BRIDGE_VERSION, iarSessionId: sessionId, disposition: 'handled', reply: result.reply, reasonCode: result.reasonCode };
  return { version: PI_BRIDGE_VERSION, iarSessionId: sessionId, disposition: 'handled', reply: result.reply };
}

/** 只公开路由摘要，禁止暴露模型和 Action 输入。 */
function toRouteEvidence(route: RouteEvidence): BridgeRouteEvidence {
  return { status: route.status, reasonCode: route.reasonCode, semanticIntent: route.semanticIntent, semanticConfidence: route.semanticConfidence, ...(route.functionId === undefined ? {} : { functionId: route.functionId }), ...(route.pluginId === undefined ? {} : { pluginId: route.pluginId }) };
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
    if (error instanceof BridgeRequestError) return reply.code(error.status).send({ version: PI_BRIDGE_VERSION, code: error.code, message: error.message, retryable: false });
    if (error instanceof SessionError) return reply.code(error.status).send({ version: PI_BRIDGE_VERSION, code: error.reasonCode, message: 'IAR 会话请求未完成。', retryable: error.status >= 500 || error.status === 429 });
    return reply.code(500).send({ version: PI_BRIDGE_VERSION, code: 'bridge_internal_error', message: 'IAR 桥接请求未完成。', retryable: true });
  }
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
