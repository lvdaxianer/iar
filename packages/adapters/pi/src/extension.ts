/**
 * 实现不修改 Pi 核心的 IAR 输入路由扩展。
 * 扩展只保留 Pi→IAR 会话映射和待确认 actionId，业务状态仍由 IAR 管理。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
import { BridgeClientError, IarBridgeClient, type IarBridgeClientLike, type BridgeLogger } from './client.js';
import type { BridgeInputResponse } from './protocol.js';

/** Pi 输入事件的最小结构。 */
export type PiInputEvent = { text: string; source: 'interactive' | 'rpc' | 'extension' };

/** Pi 扩展上下文的最小结构。 */
export type PiExtensionContext = { sessionManager: { getSessionId(): string }; ui: { notify(message: string, type?: 'info' | 'warning' | 'error'): void } };

/** Pi 输入钩子的稳定返回值。 */
export type PiInputResult = { action: 'continue' | 'handled' };

/** Pi 扩展 API 的最小结构，不把 Pi 包声明为 IAR 的运行时依赖。 */
export type PiExtensionAPI = {
  on(event: 'session_start' | 'session_shutdown' | 'input', handler: (event: unknown, context: PiExtensionContext) => Promise<unknown> | unknown): void;
  registerCommand(name: string, definition: { description: string; handler: (args: string, context: PiExtensionContext) => Promise<void> }): void;
  sendMessage(message: { customType: string; content: string; display: boolean; details?: Record<string, unknown> }, options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' }): void;
};

/** IAR Pi 扩展配置。 */
export type IarExtensionOptions = { baseUrl?: string; client?: IarBridgeClientLike; timeoutMs?: number; fetch?: import('./client.js').BridgeFetch; logger?: BridgeLogger; onUnavailable?: 'handled' | 'continue' };

/**
 * 创建可通过 Pi Package 或 SDK 加载的 IAR 扩展工厂。
 * @param options - Bridge 地址、client 和故障降级配置
 * @returns Pi 扩展工厂
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
export function createIarExtension(options: IarExtensionOptions = {}): (pi: PiExtensionAPI) => Promise<void> {
  const client = options.client ?? new IarBridgeClient({ baseUrl: options.baseUrl ?? process.env.IAR_PI_BRIDGE_URL ?? 'http://127.0.0.1:8787', ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(options.fetch === undefined ? {} : { fetch: options.fetch }), ...(options.logger === undefined ? {} : { logger: options.logger }) });
  return async (pi) => registerExtension(pi, client, options.onUnavailable ?? 'handled');
}

/**
 * 注册生命周期、输入和确认命令。
 * @param pi - Pi 扩展 API
 * @param client - IAR Bridge client
 * @param unavailableAction - Bridge 不可用时的输入动作
 * @returns 注册完成的 Promise
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
async function registerExtension(pi: PiExtensionAPI, client: IarBridgeClientLike, unavailableAction: 'handled' | 'continue'): Promise<void> {
  const state = { iarSessionId: undefined as string | undefined, pendingActionId: undefined as string | undefined, isAvailable: false };
  pi.on('session_start', async (_event, context) => initializeSession(client, state, context));
  pi.on('session_shutdown', async () => { state.iarSessionId = undefined; state.pendingActionId = undefined; state.isAvailable = false; });
  pi.on('input', async (event, context) => handleInput(pi, client, state, unavailableAction, event, context));
  registerConfirmationCommand(pi, client, state, true);
  registerConfirmationCommand(pi, client, state, false);
}

/** 初始化映射并恢复待确认摘要。 */
async function initializeSession(client: IarBridgeClientLike, state: ExtensionState, context: PiExtensionContext): Promise<void> {
  try {
    const opened = await client.openSession({ piSessionId: context.sessionManager.getSessionId() });
    state.iarSessionId = opened.iarSessionId;
    state.pendingActionId = (await client.state(opened.iarSessionId)).pending?.actionId;
    state.isAvailable = true;
  } catch {
    state.iarSessionId = undefined;
    state.pendingActionId = undefined;
    state.isAvailable = false;
    notifyUnavailable(context);
  }
}

/** 处理普通 Pi 输入，并按 IAR disposition 终止或放行 Agent。 */
async function handleInput(pi: PiExtensionAPI, client: IarBridgeClientLike, state: ExtensionState, unavailableAction: 'handled' | 'continue', event: unknown, context: PiExtensionContext): Promise<PiInputResult> {
  const input = readInputEvent(event);
  if (input.source === 'extension') return { action: 'continue' };
  if (!state.isAvailable || state.iarSessionId === undefined) return unavailableResult(unavailableAction, context);
  try {
    const response = await client.input(state.iarSessionId, input.text);
    return presentResponse(pi, state, response);
  } catch {
    state.isAvailable = false;
    if (unavailableAction === 'handled') { notifyUnavailable(context); return { action: 'handled' }; }
    return { action: 'continue' };
  }
}

/** 注册确认或取消命令。 */
function registerConfirmationCommand(pi: PiExtensionAPI, client: IarBridgeClientLike, state: ExtensionState, accepted: boolean): void {
  const name = accepted ? 'iar-confirm' : 'iar-cancel';
  pi.registerCommand(name, { description: accepted ? '确认当前 IAR 待执行动作' : '取消当前 IAR 待执行动作', handler: async (_args, context) => confirmPending(pi, client, state, accepted, context) });
}

/** 将确认操作转发给 IAR，并清理已消费的本地 actionId。 */
async function confirmPending(pi: PiExtensionAPI, client: IarBridgeClientLike, state: ExtensionState, accepted: boolean, context: PiExtensionContext): Promise<void> {
  if (!state.iarSessionId || !state.pendingActionId) { context.ui.notify('当前没有待确认的 IAR 操作。', 'warning'); return; }
  try {
    const response = await client.confirm(state.iarSessionId, state.pendingActionId, accepted);
    state.pendingActionId = response.pending?.actionId;
    presentMessage(pi, response.reply, response.reasonCode ?? (accepted ? 'confirmed' : 'cancelled'));
  } catch (error) {
    state.isAvailable = false;
    if (error instanceof BridgeClientError && error.code === 'bridge_rejected') context.ui.notify('IAR 拒绝了当前确认请求。', 'warning');
    else notifyUnavailable(context);
  }
}

/** 将 IAR 结果转换为 Pi input 返回值。 */
function presentResponse(pi: PiExtensionAPI, state: ExtensionState, response: BridgeInputResponse): PiInputResult {
  if (response.disposition === 'pass_through') return { action: 'continue' };
  state.pendingActionId = response.pending?.actionId;
  presentMessage(pi, response.reply ?? 'IAR 已处理当前请求。', response.disposition);
  return { action: 'handled' };
}

/** 展示不进入下一次 Agent 调用的 IAR custom message。 */
function presentMessage(pi: PiExtensionAPI, content: string, disposition: string): void {
  pi.sendMessage({ customType: 'iar-bridge', content, display: true, details: { disposition } }, { triggerTurn: false });
}

/** 桥接不可用时按配置返回安全处置。 */
function unavailableResult(action: 'handled' | 'continue', context: PiExtensionContext): PiInputResult {
  if (action === 'handled') { notifyUnavailable(context); return { action: 'handled' }; }
  return { action: 'continue' };
}

/** 统一展示固定桥接故障消息。 */
function notifyUnavailable(context: PiExtensionContext): void { context.ui.notify('IAR 桥接不可用，当前输入已安全阻断。', 'error'); }

/** 读取并限制 input 事件的公开字段。 */
function readInputEvent(value: unknown): PiInputEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { text: '', source: 'interactive' };
  const record = value as Record<string, unknown>;
  const text = typeof record.text === 'string' ? record.text : '';
  const source = record.source === 'rpc' || record.source === 'extension' ? record.source : 'interactive';
  return { text, source };
}

/** 扩展会话状态只保存映射和当前待确认 actionId。 */
type ExtensionState = { iarSessionId: string | undefined; pendingActionId: string | undefined; isAvailable: boolean };
