/**
 * 提供 IAR Pi bridge 的有界 HTTP client。
 * Client 只负责协议、超时和错误收敛，不复制 IAR 会话状态。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
import { PI_BRIDGE_VERSION, isBridgeDisposition, isBridgeReplySource, type BridgeCapabilityContext, type BridgeConfirmRequest, type BridgeConfirmResponse, type BridgeInputRequest, type BridgeInputResponse, type BridgeInputStreamEvent, type BridgeOpenRequest, type BridgeOpenResponse, type BridgePendingAction, type BridgeRouteEvidence, type BridgeStateResponse, type BridgeStructuredAction, type BridgeStructuredCollection, type BridgeStructuredContext, type BridgeStructuredFactRecord, type BridgeStructuredSlot, type BridgeStructuredSubject, type BridgeStructuredTurn, type BridgeStructuredWorkflow, type BridgeTimingSummary, type BridgeWorkflowState, type IarSessionId } from './protocol.js';

// 覆盖真实模型的一次完整 Bridge 请求：语义抽取、路由/回复生成和 SSE 收尾可能各自耗时，10 秒会在模型仍处于思考阶段时提前截断单会话。
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 60_000;
const BRIDGE_TIMEOUT_ENV = 'IAR_PI_BRIDGE_TIMEOUT_MS';

/** Fetch 的最小可替换接口，便于测试和宿主注入网络实现。 */
export type BridgeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Client 日志只接收固定路由和耗时，不接收消息、Action 或 Token。 */
export type BridgeLogger = { debug?: (message: string, fields?: Record<string, string | number>) => void; warn?: (message: string, fields?: Record<string, string | number>) => void };

/** Bridge 输入流回调；只暴露最终回复的思考和答案增量。 */
export type BridgeInputStreamHandlers = { onReasoningDelta?: (text: string) => void; onDelta?: (text: string) => void };

/** IAR Bridge client 配置。 */
export type IarBridgeClientOptions = { baseUrl: string; fetch?: BridgeFetch; timeoutMs?: number; logger?: BridgeLogger };

/** Bridge client 对宿主公开的稳定失败分类。 */
export type BridgeClientErrorCode =
  | 'invalid_bridge_url'
  | 'invalid_bridge_json'
  | 'invalid_bridge_timeout'
  | 'invalid_bridge_response'
  | 'bridge_unavailable'
  | 'bridge_timeout'
  | 'bridge_rejected'
  | 'bridge_internal_error'
  | 'session_unavailable'
  | 'session_busy'
  | 'session_limit'
  | 'response_model_failed';

/** 扩展使用的 client 最小行为接口。 */
export type IarBridgeClientLike = Pick<IarBridgeClient, 'openSession' | 'input' | 'confirm' | 'state'> & { inputStream?: (iarSessionId: IarSessionId, text: string, handlers: BridgeInputStreamHandlers) => Promise<BridgeInputResponse> };

/** Bridge 请求失败的稳定错误。 */
export class BridgeClientError extends Error {
  /**
   * 创建不暴露内部正文的桥接错误。
   * @param code - 稳定错误码
   * @param message - 面向扩展的安全说明
   * @param retryable - 是否允许稍后重试
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  public constructor(public readonly code: BridgeClientErrorCode, message: string, public readonly retryable: boolean) {
    super(message);
    this.name = 'BridgeClientError';
  }
}

/**
 * 调用 IAR Bridge 的 HTTP client。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
export class IarBridgeClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: BridgeFetch;
  private readonly timeoutMs: number;
  private readonly logger: BridgeLogger | undefined;

  /**
   * 初始化有界网络 client。
   * @param options - 地址、超时、Fetch 和日志配置
   * @throws BridgeClientError 当地址或超时配置无效
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  public constructor(options: IarBridgeClientOptions) {
    if (!/^https?:\/\/[^\s/]+(?:\/.*)?$/.test(options.baseUrl)) throw new BridgeClientError('invalid_bridge_url', 'IAR 桥接地址无效。', false);
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = normalizeTimeout(options.timeoutMs ?? readConfiguredTimeout());
    this.logger = options.logger;
  }

  /**
   * 打开或恢复一个 Pi→IAR 会话映射。
   * @param request - Pi 会话及可选 IAR 会话标识
   * @returns IAR 会话映射
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  public openSession(request: BridgeOpenRequest): Promise<BridgeOpenResponse> {
    return this.request({ method: 'POST', path: '/api/bridge/v1/sessions', body: request, validate: validateOpenResponse });
  }

  /**
   * 将一条原始 Pi 输入交给 IAR。
   * @param iarSessionId - IAR 行为会话标识
   * @param text - 有界用户输入
   * @returns IAR 处置结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  public input(iarSessionId: IarSessionId, text: string): Promise<BridgeInputResponse> {
    const body: BridgeInputRequest = { text };
    return this.request({ method: 'POST', path: `/api/bridge/v1/sessions/${encodeURIComponent(iarSessionId)}/input`, body, validate: validateInputResponse });
  }

  /** 将一条输入交给 IAR，并按 reasoning→answer→done 顺序转发最终回复流。
   * @param iarSessionId - IAR 行为会话标识
   * @param text - 有界用户输入
   * @param handlers - 最终回复增量回调
   * @returns IAR 终态处置结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-22
   */
  public inputStream(iarSessionId: IarSessionId, text: string, handlers: BridgeInputStreamHandlers = {}): Promise<BridgeInputResponse> {
    const body: BridgeInputRequest = { text };
    return this.streamRequest({ path: `/api/bridge/v1/sessions/${encodeURIComponent(iarSessionId)}/input/stream`, body, handlers });
  }

  /**
   * 将确认或取消转发给 IAR 权威会话。
   * @param iarSessionId - IAR 行为会话标识
   * @param actionId - 当前展示的待确认动作
   * @param accepted - true 表示确认，false 表示取消
   * @returns 确认处置结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  public confirm(iarSessionId: IarSessionId, actionId: string, accepted: boolean): Promise<BridgeConfirmResponse> {
    const body: BridgeConfirmRequest = { actionId, accepted };
    return this.request({ method: 'POST', path: `/api/bridge/v1/sessions/${encodeURIComponent(iarSessionId)}/confirm`, body, validate: validateConfirmResponse });
  }

  /**
   * 读取当前 IAR 会话的最小确认状态。
   * @param iarSessionId - IAR 行为会话标识
   * @returns 当前待确认摘要
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  public state(iarSessionId: IarSessionId): Promise<BridgeStateResponse> {
    return this.request({ method: 'GET', path: `/api/bridge/v1/sessions/${encodeURIComponent(iarSessionId)}/state`, validate: validateStateResponse });
  }

  /**
   * 执行一次 JSON HTTP 调用并统一校验结果。
   * @param options - 方法、路径、可选 body 和结果校验器
   * @returns 已校验的协议响应
   * @throws BridgeClientError 当网络、HTTP 或响应契约失败
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  private async request<T>(options: { method: 'GET' | 'POST'; path: string; body?: object; validate: (value: unknown) => T }): Promise<T> {
    const startedAt = Date.now();
    this.logger?.debug?.('IAR bridge request', { method: options.method, path: options.path.replace(/\/[^/]+\/(input|confirm|state)$/, '/:sessionId/$1') });
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${options.path}`, requestInit(options.method, options.body, this.timeoutMs));
      const durationMs = Date.now() - startedAt;
      this.logger?.debug?.('IAR bridge response', { method: options.method, status: response.status, durationMs });
      if (!response.ok) throw await httpError(response.status, response);
      const payload = await readJson(response);
      return options.validate(payload);
    } catch (error) {
      const normalized = normalizeClientError(error);
      this.logger?.warn?.('IAR bridge failure', { method: options.method, path: options.path.replace(/\/[^/]+\/(input|confirm|state)$/, '/:sessionId/$1') });
      throw normalized;
    }
  }

  /** 执行 SSE 输入请求并统一校验事件顺序及终态。 */
  private async streamRequest(options: { path: string; body: BridgeInputRequest; handlers: BridgeInputStreamHandlers }): Promise<BridgeInputResponse> {
    const startedAt = Date.now();
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${options.path}`, requestInit('POST', options.body, this.timeoutMs));
      if (!response.ok) throw await httpError(response.status, response);
      const result = await readBridgeInputStream(response, options.handlers);
      this.logger?.debug?.('IAR bridge stream response', { method: 'POST', status: response.status, durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      const normalized = normalizeClientError(error);
      this.logger?.warn?.('IAR bridge stream failure', { method: 'POST', path: options.path.replace(/\/[^/]+\/input\/stream$/, '/:sessionId/input/stream') });
      throw normalized;
    }
  }
}

/** 读取宿主配置的 Bridge 默认超时；显式 constructor 配置优先。 */
function readConfiguredTimeout(): number | undefined {
  const value = process.env[BRIDGE_TIMEOUT_ENV];
  return value === undefined ? undefined : Number(value);
}

/** 构造固定 JSON 请求配置。 */
function requestInit(method: 'GET' | 'POST', body: object | undefined, timeoutMs: number): RequestInit {
  return { method, headers: { accept: 'application/json', 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs), ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

/** 读取 JSON，失败时转换为稳定错误。 */
async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { throw new BridgeClientError('invalid_bridge_json', 'IAR 桥接响应无效。', false); }
}

/** 读取 Bridge 输入 SSE，并拒绝 reasoning 与 answer 交错或缺失 done。 */
async function readBridgeInputStream(response: Response, handlers: BridgeInputStreamHandlers): Promise<BridgeInputResponse> {
  if (!response.body) throw new BridgeClientError('invalid_bridge_response', 'IAR 桥接流无效。', false);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answerStarted = false;
  let result: BridgeInputResponse | undefined;
  while (result === undefined) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
    const lines = buffer.split('\n\n');
    buffer = lines.pop() ?? '';
    for (const block of lines) {
      const event = parseBridgeStreamBlock(block);
      if (event === undefined) continue;
      result = consumeBridgeStreamEvent(event, handlers, answerStarted);
      if (event.type === 'delta') answerStarted = true;
      if (result !== undefined) break;
    }
    if (chunk.done) break;
  }
  if (result === undefined) throw new BridgeClientError('invalid_bridge_response', 'IAR 桥接流未返回终态。', false);
  return result;
}

/** 将一个 SSE data 块解析为受限 Bridge 事件。 */
function parseBridgeStreamBlock(block: string): BridgeInputStreamEvent | undefined {
  const line = block.split('\n').find((item) => item.startsWith('data:'));
  if (line === undefined) return undefined;
  try { return validateBridgeStreamEvent(JSON.parse(line.slice(5).trim())); }
  catch (error) { if (error instanceof BridgeClientError) throw error; throw new BridgeClientError('invalid_bridge_response', 'IAR 桥接流事件无效。', false); }
}

/** 分发单个流事件；reasoning 在 answer 开始后会被拒绝。 */
function consumeBridgeStreamEvent(event: BridgeInputStreamEvent, handlers: BridgeInputStreamHandlers, answerStarted: boolean): BridgeInputResponse | undefined {
  if (event.type === 'reasoningDelta') { if (answerStarted) throw new BridgeClientError('invalid_bridge_response', 'IAR 桥接流顺序无效。', false); handlers.onReasoningDelta?.(event.text); return undefined; }
  if (event.type === 'delta') { handlers.onDelta?.(event.text); return undefined; }
  if (event.type === 'timing') return undefined;
  if (event.type === 'error') throw new BridgeClientError(mapServerErrorCode(event.code, 500), event.message, event.retryable);
  return validateInputResponse(event.result);
}

/** 校验 Bridge 输入流事件，拒绝自由格式正文进入回调。 */
function validateBridgeStreamEvent(value: unknown): BridgeInputStreamEvent {
  const record = asRecord(value);
  if (record.type === 'reasoningDelta' || record.type === 'delta') {
    if (!isBoundedString(record.text, 32_000)) throw new BridgeClientError('invalid_bridge_response', 'IAR 桥接流事件无效。', false);
    return { type: record.type, text: record.text };
  }
  if (record.type === 'timing') return { type: 'timing', summary: validateTiming(record.summary) };
  if (record.type === 'done') return { type: 'done', result: validateInputResponse(record.result) };
  if (record.type === 'error' && isBoundedString(record.code, 128) && isBoundedString(record.message, 512) && typeof record.retryable === 'boolean') return { type: 'error', code: record.code, message: record.message, retryable: record.retryable };
  throw new BridgeClientError('invalid_bridge_response', 'IAR 桥接流事件无效。', false);
}

/** HTTP 状态到稳定错误的映射。 */
async function httpError(status: number, response: Response): Promise<BridgeClientError> {
  const payload = await readErrorPayload(response);
  const code = mapServerErrorCode(payload?.code, status);
  const retryable = typeof payload?.retryable === 'boolean' ? payload.retryable : status >= 500 || status === 429;
  return new BridgeClientError(code, errorMessage(code), retryable);
}

/** 读取错误响应中的稳定字段；正文损坏时回退到 HTTP 状态分类。 */
async function readErrorPayload(response: Response): Promise<{ code?: string; retryable?: boolean } | undefined> {
  try {
    const value = await response.json() as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    return { ...(typeof record.code === 'string' ? { code: record.code } : {}), ...(typeof record.retryable === 'boolean' ? { retryable: record.retryable } : {}) };
  } catch {
    return undefined;
  }
}

/** 将 Bridge 服务端错误码投影为 Pi 宿主可消费的有限分类。 */
function mapServerErrorCode(value: string | undefined, status: number): BridgeClientErrorCode {
  if (value === 'session_not_found' || value === 'invalid_session_id') return 'session_unavailable';
  if (value === 'session_busy') return 'session_busy';
  if (value === 'session_limit') return 'session_limit';
  if (value === 'bridge_internal_error') return 'bridge_internal_error';
  if (value?.startsWith('model.') || value === 'response_model_failed') return 'response_model_failed';
  if (status >= 500 || status === 429) return 'bridge_unavailable';
  return 'bridge_rejected';
}

/** 只返回固定安全文案，避免把服务端异常正文传播给 Pi。 */
function errorMessage(code: BridgeClientErrorCode): string {
  if (code === 'bridge_unavailable') return 'IAR 桥接不可用。';
  if (code === 'bridge_timeout') return 'IAR 桥接请求超时。';
  if (code === 'bridge_rejected') return 'IAR 桥接请求被拒绝。';
  if (code === 'bridge_internal_error') return 'IAR 服务处理失败。';
  if (code === 'session_unavailable') return 'IAR 会话不可用。';
  if (code === 'session_busy') return 'IAR 会话繁忙。';
  if (code === 'session_limit') return 'IAR 会话操作次数已达上限。';
  if (code === 'response_model_failed') return 'Response Model 处理失败。';
  return 'IAR 桥接响应无效。';
}

/** 把未知异常收敛为不泄露原文的 Client 错误。 */
function normalizeClientError(error: unknown): BridgeClientError {
  if (error instanceof BridgeClientError) return error;
  if (error instanceof DOMException && error.name === 'TimeoutError') return new BridgeClientError('bridge_timeout', 'IAR 桥接请求超时。', true);
  return new BridgeClientError('bridge_unavailable', 'IAR 桥接不可用。', true);
}

/** 校验打开响应。 */
function validateOpenResponse(value: unknown): BridgeOpenResponse {
  const record = asRecord(value);
  if (record.version !== PI_BRIDGE_VERSION || !isString(record.piSessionId) || !isString(record.iarSessionId) || typeof record.resumed !== 'boolean') throw new BridgeClientError('invalid_bridge_response', 'IAR 桥接响应无效。', false);
  return { version: PI_BRIDGE_VERSION, piSessionId: record.piSessionId, iarSessionId: record.iarSessionId, resumed: record.resumed };
}

/** 校验输入响应。 */
function validateInputResponse(value: unknown): BridgeInputResponse {
  const record = validateCommonResponse(value);
  if (!isBridgeDisposition(record.disposition)) throw new BridgeClientError('invalid_bridge_response', 'IAR 桥接响应无效。', false);
  const capabilityContext = record.capabilityContext === undefined ? undefined : validateCapabilityContext(record.capabilityContext);
  const replySource = optionalReplySource(record);
  const route = record.route === undefined ? undefined : validateRoute(record.route);
  const timing = record.timing === undefined ? undefined : validateTiming(record.timing);
  return { version: PI_BRIDGE_VERSION, iarSessionId: record.iarSessionId, disposition: record.disposition, ...optionalString(record, 'reply'), ...optionalString(record, 'reasonCode'), ...(route === undefined ? {} : { route }), ...(record.pending === undefined ? {} : { pending: validatePending(record.pending) }), ...(capabilityContext === undefined ? {} : { capabilityContext }), ...(replySource === undefined ? {} : { replySource }), ...(timing === undefined ? {} : { timing }) };
}

/** 校验公开路由证据，禁止 Bridge 携带原始模型上下文。 */
function validateRoute(value: unknown): BridgeRouteEvidence {
  const record = asRecord(value);
  if (!isBoundedString(record.status, 64) || !isBoundedString(record.reasonCode, 128) || !isBoundedString(record.semanticIntent, 256) || typeof record.semanticConfidence !== 'number' || record.semanticConfidence < 0 || record.semanticConfidence > 1) throw new BridgeClientError('invalid_bridge_response', 'IAR 路由证据无效。', false);
  if (record.operationKind !== undefined && record.operationKind !== 'read' && record.operationKind !== 'action') throw new BridgeClientError('invalid_bridge_response', 'IAR 路由证据无效。', false);
  return { status: record.status, reasonCode: record.reasonCode, semanticIntent: record.semanticIntent, semanticConfidence: record.semanticConfidence, ...(optionalBounded(record, 'functionId', 256)), ...(optionalBounded(record, 'pluginId', 256)), ...(record.operationKind === undefined ? {} : { operationKind: record.operationKind }), ...optionalRouteIdentifier(record, 'expectedOperation'), ...optionalRouteIdentifier(record, 'actualOperation') };
}

/** 校验契约诊断中的有限操作标识，拒绝自由文本进入 Bridge。 */
function optionalRouteIdentifier(record: Record<string, unknown>, key: string): Record<string, string> {
  if (record[key] === undefined) return {};
  if (typeof record[key] !== 'string' || !/^[A-Za-z0-9_.|:-]{1,256}$/.test(record[key])) throw new BridgeClientError('invalid_bridge_response', 'IAR 路由证据无效。', false);
  return { [key]: record[key] };
}

/** 读取路由证据中的可选标识。 */
function optionalBounded(record: Record<string, unknown>, key: string, maxLength: number): Record<string, string> {
  if (record[key] === undefined) return {};
  if (!isBoundedString(record[key], maxLength)) throw new BridgeClientError('invalid_bridge_response', 'IAR 路由证据无效。', false);
  return { [key]: record[key] };
}

/** 校验 pass-through 能力上下文的有界公开字段。 */
function validateCapabilityContext(value: unknown): BridgeCapabilityContext {
  const record = asRecord(value);
  if (!Array.isArray(record.functionDescriptors) || record.functionDescriptors.length > 128) throw new BridgeClientError('invalid_bridge_response', 'IAR 能力上下文无效。', false);
  const functionDescriptors = record.functionDescriptors.map((item) => {
    const descriptor = asRecord(item);
    if (!isBoundedString(descriptor.functionId, 256) || !isBoundedString(descriptor.pluginId, 256) || !isBoundedString(descriptor.description, 400) || !Array.isArray(descriptor.actionTypes) || descriptor.actionTypes.length === 0 || descriptor.actionTypes.length > 8 || descriptor.actionTypes.some((action) => !isBoundedString(action, 32))) throw new BridgeClientError('invalid_bridge_response', 'IAR 能力上下文无效。', false);
    return { functionId: descriptor.functionId, pluginId: descriptor.pluginId, description: descriptor.description, actionTypes: descriptor.actionTypes as string[] };
  });
  return { functionDescriptors };
}

/** 校验确认响应。 */
function validateConfirmResponse(value: unknown): BridgeConfirmResponse {
  const record = validateCommonResponse(value);
  if (!isString(record.reply)) throw new BridgeClientError('invalid_bridge_response', 'IAR 桥接响应无效。', false);
  const replySource = optionalReplySource(record);
  const timing = record.timing === undefined ? undefined : validateTiming(record.timing);
  return { version: PI_BRIDGE_VERSION, iarSessionId: record.iarSessionId, disposition: 'handled', reply: record.reply, ...optionalString(record, 'reasonCode'), ...(record.pending === undefined ? {} : { pending: validatePending(record.pending) }), ...(replySource === undefined ? {} : { replySource }), ...(timing === undefined ? {} : { timing }) };
}

/**
 * 校验耗时摘要，限制阶段数量和数值边界，拒绝正文型扩展字段。
 */
function validateTiming(value: unknown): BridgeTimingSummary {
  const record = asRecord(value);
  if (!isBoundedString(record.traceId, 256) || !isDuration(record.durationMs) || !Array.isArray(record.stages) || record.stages.length > 32) throw new BridgeClientError('invalid_bridge_response', 'IAR 耗时摘要无效。', false);
  const stages = record.stages.map((item) => {
    const stage = asRecord(item);
    if (!['semantic.extract', 'route.propose', 'route.select', 'action.execute', 'response.reasoning', 'response.generate'].includes(String(stage.stage)) || !['completed', 'failed', 'skipped'].includes(String(stage.status)) || !isDuration(stage.durationMs)) throw new BridgeClientError('invalid_bridge_response', 'IAR 耗时摘要无效。', false);
    if (stage.firstTokenMs !== undefined && !isDuration(stage.firstTokenMs)) throw new BridgeClientError('invalid_bridge_response', 'IAR 耗时摘要无效。', false);
    return { stage: stage.stage, status: stage.status, durationMs: stage.durationMs, ...(stage.firstTokenMs === undefined ? {} : { firstTokenMs: stage.firstTokenMs }) } as BridgeTimingSummary['stages'][number];
  });
  return { traceId: record.traceId, durationMs: record.durationMs, stages };
}

/**
 * 只接受非负安全整数耗时。
 */
function isDuration(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }

/** 校验状态响应。 */
function validateStateResponse(value: unknown): BridgeStateResponse {
  const record = validateCommonResponse(value);
  const structuredContext = record.structuredContext === undefined ? undefined : validateStructuredContext(record.structuredContext);
  const workflowState = record.workflowState === undefined ? undefined : validateWorkflowState(record.workflowState);
  return { version: PI_BRIDGE_VERSION, iarSessionId: record.iarSessionId, ...(record.pending === undefined ? {} : { pending: validatePending(record.pending) }), ...(structuredContext === undefined ? {} : { structuredContext }), ...(workflowState === undefined ? {} : { workflowState }) };
}

/** 校验状态响应中的安全结构化上下文，拒绝原始消息和授权字段。 */
function validateStructuredContext(value: unknown): BridgeStructuredContext {
  const record = requiredRecord(value);
  if (record.schemaVersion !== 'iar.pi-structured-context/v1') throw invalidResponse();
  const subject = validateStructuredSubject(record.subject);
  const action = validateStructuredAction(record.action);
  const workflow = validateStructuredWorkflow(record.workflow);
  const route = validateStructuredRoute(record.route);
  const slots = validateStructuredSlots(record.slots);
  const pending = validatePendingState(record.pending);
  const confirmation = validateConfirmationState(record.confirmation);
  const factHistory = validateFactHistory(record.factHistory);
  const conversationTurns = validateConversationTurns(record.conversationTurns);
  const routingScope = record.routingScope === undefined ? undefined : validateRoutingScope(record.routingScope);
  const clarification = record.clarification === undefined ? undefined : validateClarification(record.clarification);
  const collection = record.collection === undefined ? undefined : validateCollection(record.collection);
  const pendingReference = record.pendingReference === undefined ? undefined : validatePendingReference(record.pendingReference);
  const summary = record.summary === undefined ? undefined : validateSummary(record.summary);
  const integrity = validateIntegrity(record.integrity);
  return { schemaVersion: 'iar.pi-structured-context/v1', subject, intent: bounded(record.intent, 512), action, route, slots, workflow, pending, ...(routingScope ? { routingScope } : {}), ...(clarification ? { clarification } : {}), ...(collection ? { collection } : {}), ...(pendingReference ? { pendingReference } : {}), confirmation, factHistory, conversationTurns, ...(summary ? { summary } : {}), integrity };
}

/** 校验状态响应中的 Workflow 投影。 */
function validateWorkflowState(value: unknown): BridgeWorkflowState {
  const record = requiredRecord(value);
  if (record.mapVersion !== 'iar.workflow-map/v1' || !isBoundedString(record.currentState, 64) || !isBoundedString(record.activeState, 64) || !['none', 'completed', 'cancelled', 'failed'].includes(String(record.outcome)) || !['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled'].includes(String(record.workflowStatus)) || !boundedStringArray(record.allowedEvents, 64, 64)) throw invalidResponse();
  const pending = validatePendingState(record.pending);
  const confirmation = validateConfirmationState(record.confirmation);
  const route = record.route === undefined ? undefined : validateStructuredRoute(record.route);
  const collection = record.collection === undefined ? undefined : validateCollection(record.collection);
  return { mapVersion: 'iar.workflow-map/v1', currentState: record.currentState, activeState: record.activeState, outcome: record.outcome as BridgeWorkflowState['outcome'], workflowStatus: record.workflowStatus as BridgeWorkflowState['workflowStatus'], allowedEvents: record.allowedEvents as string[], pending, confirmation, ...(route ? { route } : {}), ...(collection ? { collection } : {}) };
}

/** 校验结构化上下文主语、动作和工作流。 */
function validateStructuredSubject(value: unknown): BridgeStructuredSubject {
  const record = requiredRecord(value);
  if (!isBoundedString(record.type, 128) || !isBoundedString(record.id, 256) || !['resolved', 'unresolved'].includes(String(record.status)) || !['input', 'context', 'event', 'plugin'].includes(String(record.source))) throw invalidResponse();
  return { type: record.type, id: record.id, status: record.status as BridgeStructuredSubject['status'], source: record.source as BridgeStructuredSubject['source'], ...optionalBoundedString(record, 'sourceEventId', 256) };
}

function validateStructuredAction(value: unknown): BridgeStructuredAction {
  const record = requiredRecord(value);
  if (!isBoundedString(record.name, 256) || !['proposed', 'resolved', 'executed', 'failed'].includes(String(record.status))) throw invalidResponse();
  return { name: record.name, status: record.status as BridgeStructuredAction['status'] };
}

function validateStructuredWorkflow(value: unknown): BridgeStructuredWorkflow {
  const record = requiredRecord(value);
  if (!isBoundedString(record.currentStep, 256) || !['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled'].includes(String(record.status))) throw invalidResponse();
  return { currentStep: record.currentStep, status: record.status as BridgeStructuredWorkflow['status'], ...optionalBoundedString(record, 'workflowId', 256) };
}

function validateStructuredRoute(value: unknown): { functionId?: string; pluginId?: string } {
  const record = requiredRecord(value);
  const functionId = optionalBoundedString(record, 'functionId', 256);
  const pluginId = optionalBoundedString(record, 'pluginId', 256);
  if (!functionId && !pluginId) return {};
  return { ...functionId, ...pluginId };
}

function validateStructuredSlots(value: unknown): Record<string, BridgeStructuredSlot> {
  const record = requiredRecord(value);
  const entries = Object.entries(record);
  if (entries.length > 64) throw invalidResponse();
  return Object.fromEntries(entries.map(([key, item]) => [bounded(key, 128), validateStructuredSlot(item)]));
}

function validateStructuredSlot(value: unknown): BridgeStructuredSlot {
  const record = requiredRecord(value);
  if (!['unresolved', 'resolved', 'confirmed'].includes(String(record.status))) throw invalidResponse();
  return { status: record.status as BridgeStructuredSlot['status'], ...optionalBoundedString(record, 'sourceEventId', 256) };
}

function validatePendingState(value: unknown): BridgeStructuredContext['pending'] {
  const record = requiredRecord(value);
  if (!['slot', 'selection', 'confirmation', 'input'].includes(String(record.kind)) || !['required', 'received', 'none'].includes(String(record.status))) throw invalidResponse();
  return { kind: record.kind as BridgeStructuredContext['pending']['kind'], status: record.status as BridgeStructuredContext['pending']['status'] };
}

function validateConfirmationState(value: unknown): BridgeStructuredContext['confirmation'] {
  const record = requiredRecord(value);
  if (!['not_required', 'required', 'confirmed', 'rejected'].includes(String(record.state))) throw invalidResponse();
  return { state: record.state as BridgeStructuredContext['confirmation']['state'] };
}

function validateRoutingScope(value: unknown): NonNullable<BridgeStructuredContext['routingScope']> {
  const record = requiredRecord(value);
  if (!boundedStringArray(record.candidatePluginIds, 256, 64) || !boundedStringArray(record.actionTypes, 64, 64) || !['none', 'reuse', 'replace'].includes(String(record.continuation))) throw invalidResponse();
  return { candidatePluginIds: record.candidatePluginIds as string[], actionTypes: record.actionTypes as string[], continuation: record.continuation as 'none' | 'reuse' | 'replace', ...optionalBoundedString(record, 'activePluginId', 256) };
}

function validateClarification(value: unknown): NonNullable<BridgeStructuredContext['clarification']> {
  const record = requiredRecord(value);
  if (!['none', 'unresolved', 'selection'].includes(String(record.mode)) || !boundedInteger(record.unresolvedStreak, 0, 64)) throw invalidResponse();
  const candidateKeys = record.candidateKeys === undefined ? undefined : boundedStringArray(record.candidateKeys, 128, 64) ? record.candidateKeys as string[] : undefined;
  if (record.candidateKeys !== undefined && candidateKeys === undefined) throw invalidResponse();
  return { mode: record.mode as 'none' | 'unresolved' | 'selection', unresolvedStreak: record.unresolvedStreak as number, ...optionalBoundedString(record, 'reasonCode', 128), ...optionalBoundedString(record, 'candidateVersion', 256), ...(candidateKeys ? { candidateKeys } : {}) };
}

function validateCollection(value: unknown): BridgeStructuredCollection {
  const record = requiredRecord(value);
  if (record.kind === 'function') {
    if (!boundedInteger(record.candidateFunctionCount, 0, 128)) throw invalidResponse();
    const candidateKeys = record.candidateKeys === undefined ? undefined : boundedStringArray(record.candidateKeys, 128, 64) ? record.candidateKeys as string[] : undefined;
    if (record.candidateKeys !== undefined && candidateKeys === undefined) throw invalidResponse();
    return { kind: 'function', candidateFunctionCount: record.candidateFunctionCount as number, ...optionalBoundedString(record, 'pluginId', 256), ...(candidateKeys ? { candidateKeys } : {}) };
  }
  if (record.kind !== 'parameters' || !isBoundedString(record.functionId, 256) || !isBoundedString(record.schemaVersion, 256) || !boundedStringArray(record.collectedFields, 128, 64) || !boundedStringArray(record.missingFields, 128, 64) || !boundedStringArray(record.invalidFields, 128, 64) || !boundedStringArray(record.conflictFields, 128, 64) || !boundedStringArray(record.presentationFields, 128, 64)) throw invalidResponse();
  return { kind: 'parameters', functionId: record.functionId, schemaVersion: record.schemaVersion, collectedFields: record.collectedFields as string[], missingFields: record.missingFields as string[], invalidFields: record.invalidFields as string[], conflictFields: record.conflictFields as string[], presentationFields: record.presentationFields as string[], ...optionalBoundedString(record, 'pluginId', 256) };
}

function validatePendingReference(value: unknown): NonNullable<BridgeStructuredContext['pendingReference']> {
  const record = requiredRecord(value);
  if (!['current', 'previous', 'next', 'first', 'last', 'offset'].includes(String(record.relation)) || !boundedStringArray(record.candidateRecordIds, 256, 64)) throw invalidResponse();
  if (record.offset !== undefined && !boundedInteger(record.offset, 0, 64)) throw invalidResponse();
  return { relation: record.relation as NonNullable<BridgeStructuredContext['pendingReference']>['relation'], candidateRecordIds: record.candidateRecordIds as string[], ...optionalBoundedString(record, 'anchorRecordId', 256), ...(record.offset === undefined ? {} : { offset: record.offset as number }) };
}

function validateFactHistory(value: unknown): BridgeStructuredContext['factHistory'] {
  const record = requiredRecord(value);
  if (!Array.isArray(record.records) || record.records.length > 64) throw invalidResponse();
  const records = record.records.map(validateFactRecord);
  return { records, ...optionalBoundedString(record, 'focusRecordId', 256) };
}

function validateFactRecord(value: unknown): BridgeStructuredFactRecord {
  const record = requiredRecord(value);
  if (!isBoundedString(record.recordId, 256) || !boundedInteger(record.sequence, 0, Number.MAX_SAFE_INTEGER) || !isBoundedString(record.sourceEventId, 256) || !isBoundedString(record.functionId, 256) || !isBoundedString(record.pluginId, 256) || !isBoundedString(record.createdAt, 128)) throw invalidResponse();
  const values = requiredRecord(record.values);
  if (Object.keys(values).length > 64 || Object.values(values).some((value) => !['string', 'number', 'boolean'].includes(typeof value) && value !== null)) throw invalidResponse();
  return { recordId: record.recordId, sequence: record.sequence as number, sourceEventId: record.sourceEventId, functionId: record.functionId, pluginId: record.pluginId, values: values as BridgeStructuredFactRecord['values'], createdAt: record.createdAt };
}

function validateConversationTurns(value: unknown): BridgeStructuredContext['conversationTurns'] {
  const record = requiredRecord(value);
  if (!Array.isArray(record.turns) || record.turns.length > 64) throw invalidResponse();
  return { turns: record.turns.map(validateStructuredTurn), ...optionalBoundedString(record, 'focusTurnId', 256) };
}

function validateStructuredTurn(value: unknown): BridgeStructuredTurn {
  const record = requiredRecord(value);
  if (!isBoundedString(record.turnId, 256) || !boundedInteger(record.sequence, 0, Number.MAX_SAFE_INTEGER) || !['completed', 'awaiting_confirmation', 'needs_clarification', 'failed', 'cancelled'].includes(String(record.outcome)) || typeof record.actionTaken !== 'boolean' || !isBoundedString(record.completedAt, 128)) throw invalidResponse();
  return { turnId: record.turnId, sequence: record.sequence as number, outcome: record.outcome as BridgeStructuredTurn['outcome'], actionTaken: record.actionTaken, completedAt: record.completedAt };
}

function validateSummary(value: unknown): NonNullable<BridgeStructuredContext['summary']> {
  const record = requiredRecord(value);
  if (!isBoundedString(record.version, 256) || !isBoundedString(record.eventId, 256)) throw invalidResponse();
  return { version: record.version, eventId: record.eventId };
}

function validateIntegrity(value: unknown): BridgeStructuredContext['integrity'] {
  const record = requiredRecord(value);
  if (!isBoundedString(record.criticalFieldHash, 256) || !isBoundedString(record.lastEventId, 256)) throw invalidResponse();
  return { criticalFieldHash: record.criticalFieldHash, lastEventId: record.lastEventId };
}

function bounded(value: unknown, maxLength: number): string {
  if (!isBoundedString(value, maxLength)) throw invalidResponse();
  return value;
}

function optionalBoundedString(record: Record<string, unknown>, key: string, maxLength: number): Record<string, string> {
  if (record[key] === undefined) return {};
  return { [key]: bounded(record[key], maxLength) };
}

function boundedStringArray(value: unknown, itemLength: number, maxItems: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => isBoundedString(item, itemLength));
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function invalidResponse(): never {
  throw new BridgeClientError('invalid_bridge_response', 'IAR 桥接响应无效。', false);
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidResponse();
  return value as Record<string, unknown>;
}

/** 校验所有会话响应共有字段。 */
function validateCommonResponse(value: unknown): Record<string, unknown> & { iarSessionId: string; disposition?: unknown } {
  const record = asRecord(value);
  if (record.version !== PI_BRIDGE_VERSION || !isString(record.iarSessionId)) throw new BridgeClientError('invalid_bridge_response', 'IAR 桥接响应无效。', false);
  return record as Record<string, unknown> & { iarSessionId: string; disposition?: unknown };
}

/** 校验公开待确认摘要，禁止把 Action input 带回 Pi。 */
function validatePending(value: unknown): BridgePendingAction {
  const record = asRecord(value);
  const fields = ['actionId', 'runId', 'functionId', 'pluginId', 'riskLevel'] as const;
  if (fields.some((field) => !isString(record[field])) || typeof record.confirmationRequired !== 'boolean') throw new BridgeClientError('invalid_bridge_response', 'IAR 桥接响应无效。', false);
  return { actionId: record.actionId as string, runId: record.runId as string, functionId: record.functionId as string, pluginId: record.pluginId as string, riskLevel: record.riskLevel as string, confirmationRequired: record.confirmationRequired };
}

/** 读取可选字符串字段。 */
function optionalString(record: Record<string, unknown>, key: string): Record<string, string> {
  return record[key] === undefined ? {} : isString(record[key]) ? { [key]: record[key] } : failResponse();
}

/** 读取可选回复来源，保留旧版 Bridge 响应兼容性。 */
function optionalReplySource(record: Record<string, unknown>): import('./protocol.js').BridgeReplySource | undefined {
  return record.replySource === undefined ? undefined : isBridgeReplySource(record.replySource) ? record.replySource : failResponse();
}

/** 返回永远不会成功的响应构造分支。 */
function failResponse(): never {
  throw new BridgeClientError('invalid_bridge_response', 'IAR 桥接响应无效。', false);
}

/** 判断有限字符串。 */
function isString(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }

/** 判断有长度上限的公开字符串。 */
function isBoundedString(value: unknown, maxLength: number): value is string { return isString(value) && value.length <= maxLength; }

/** 将未知值收窄为普通对象。 */
function asRecord(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

/** 约束调用超时，避免无限等待远程 IAR。 */
function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) throw new BridgeClientError('invalid_bridge_timeout', 'IAR 桥接超时配置无效。', false);
  return value;
}
