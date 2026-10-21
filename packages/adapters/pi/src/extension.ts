/**
 * 实现不修改 Pi 核心的 IAR 输入路由扩展。
 * 扩展只保留 Pi→IAR 会话映射和待确认 actionId，业务状态仍由 IAR 管理。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
import { BridgeClientError, IarBridgeClient, type IarBridgeClientLike, type BridgeLogger } from './client.js';
import { isBridgeReplySource, type BridgeInputResponse, type BridgeReplySource } from './protocol.js';

/** Pi 输入事件的最小结构。 */
export type PiInputEvent = { text: string; source: 'interactive' | 'rpc' | 'extension' };

/** Pi 扩展上下文的最小结构。 */
export type PiExtensionContext = { sessionManager: { getSessionId(): string }; ui: { notify(message: string, type?: 'info' | 'warning' | 'error'): void }; mode?: 'tui' | 'rpc' | 'json' | 'print' };

/** Pi 输入钩子的稳定返回值。 */
export type PiInputResult = { action: 'continue' | 'handled' };

/** Pi 扩展 API 的最小结构，不把 Pi 包声明为 IAR 的运行时依赖。 */
export type PiExtensionAPI = {
  on(event: 'session_start' | 'session_shutdown' | 'input', handler: (event: unknown, context: PiExtensionContext) => Promise<unknown> | unknown): void;
  registerCommand(name: string, definition: { description: string; handler: (args: string, context: PiExtensionContext) => Promise<void> }): void;
  appendEntry(customType: string, data?: unknown): void;
  registerEntryRenderer(customType: string, renderer: PiEntryRenderer): void;
};

/** Pi TUI entry renderer 所需的最小组件结构。 */
export type PiEntryComponent = { render(width: number): string[]; invalidate(): void };

/** Pi entry renderer 的最小结构，不引入 Pi TUI runtime。 */
export type PiEntryRenderer = (entry: { data?: unknown }, options: { expanded: boolean }, theme: unknown) => PiEntryComponent | undefined;

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
  const state: ExtensionState = { iarSessionId: undefined, pendingActionId: undefined, isAvailable: false, unavailableNotified: false };
  pi.registerEntryRenderer('iar-bridge', renderBridgeEntry);
  pi.on('session_start', async (_event, context) => initializeSession(client, state, context));
  pi.on('session_shutdown', async () => { state.iarSessionId = undefined; state.pendingActionId = undefined; state.isAvailable = false; state.unavailableNotified = false; });
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
    notifyUnavailable(context, state);
  }
}

/** 处理普通 Pi 输入，并按 IAR disposition 终止或放行 Agent。 */
async function handleInput(pi: PiExtensionAPI, client: IarBridgeClientLike, state: ExtensionState, unavailableAction: 'handled' | 'continue', event: unknown, context: PiExtensionContext): Promise<PiInputResult> {
  const input = readInputEvent(event);
  if (input.source === 'extension') return { action: 'continue' };
  if (!state.isAvailable || state.iarSessionId === undefined) return unavailableResult(unavailableAction, context, state);
  try {
    const response = await client.input(state.iarSessionId, input.text);
    return presentResponse(pi, state, response, context);
  } catch {
    state.isAvailable = false;
    if (unavailableAction === 'handled') { notifyUnavailable(context, state); return { action: 'handled' }; }
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
    presentMessage(pi, context, response.reply, response.reasonCode ?? (accepted ? 'confirmed' : 'cancelled'), response.replySource);
  } catch (error) {
    state.isAvailable = false;
    if (error instanceof BridgeClientError && error.code === 'bridge_rejected') context.ui.notify('IAR 拒绝了当前确认请求。', 'warning');
    else notifyUnavailable(context, state);
  }
}

/** 将 IAR 结果转换为 Pi input 返回值。 */
function presentResponse(pi: PiExtensionAPI, state: ExtensionState, response: BridgeInputResponse, context: PiExtensionContext): PiInputResult {
  if (response.disposition === 'pass_through') return { action: 'continue' };
  state.pendingActionId = response.pending?.actionId;
  presentMessage(pi, context, response.reply ?? 'IAR 已处理当前请求。', response.disposition, response.replySource);
  return { action: 'handled' };
}

/** 展示不进入后续 Agent context 的 IAR custom entry。 */
function presentMessage(pi: PiExtensionAPI, context: PiExtensionContext, content: string, disposition: string, replySource?: BridgeReplySource): void {
  const safeContent = sanitizeDisplayText(content);
  pi.appendEntry('iar-bridge', { content: safeContent, disposition: sanitizeDisplayText(disposition), ...(replySource === undefined ? {} : { replySource }) });
  if (context.mode !== undefined && context.mode !== 'tui') context.ui.notify(safeContent, 'info');
}

/** 将 IAR custom entry 渲染为受控纯文本组件。 */
function renderBridgeEntry(entry: { data?: unknown }): PiEntryComponent | undefined {
  const data = readBridgeEntryData(entry.data);
  if (!data) return undefined;
  const text = `[IAR ${data.disposition}${data.replySource === undefined ? '' : ` · ${data.replySource}`}] ${data.content}`;
  return { render: (width) => wrapDisplayText(text, width), invalidate: () => {} };
}

/** 读取 entry 数据并拒绝不符合扩展契约的值。 */
function readBridgeEntryData(value: unknown): { content: string; disposition: string; replySource?: BridgeReplySource } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.content !== 'string' || typeof record.disposition !== 'string') return undefined;
  if (record.replySource !== undefined && !isBridgeReplySource(record.replySource)) return undefined;
  return { content: sanitizeDisplayText(record.content), disposition: sanitizeDisplayText(record.disposition), ...(record.replySource === undefined ? {} : { replySource: record.replySource }) };
}

/** 移除终端控制字符并限制展示长度，避免异常回复影响 Pi UI。 */
function sanitizeDisplayText(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').slice(0, MAX_DISPLAY_CHARS);
}

/** 按 renderer 提供的宽度拆分文本，避免单行内容溢出终端。 */
function wrapDisplayText(value: string, width: number): string[] {
  const safeWidth = Number.isFinite(width) && width > 0 ? Math.floor(width) : 80;
  const lines: string[] = [];
  for (const line of value.split('\n')) {
    if (line.length === 0) { lines.push(''); continue; }
    for (let index = 0; index < line.length; index += safeWidth) lines.push(line.slice(index, index + safeWidth));
  }
  return lines;
}

/** 桥接不可用时按配置返回安全处置。 */
function unavailableResult(action: 'handled' | 'continue', context: PiExtensionContext, state: ExtensionState): PiInputResult {
  if (action === 'handled') { notifyUnavailable(context, state); return { action: 'handled' }; }
  return { action: 'continue' };
}

/** 统一展示固定桥接故障消息；每个 Pi 会话只告知一次，避免重复打断输入。 */
function notifyUnavailable(context: PiExtensionContext, state: ExtensionState): void {
  if (state.unavailableNotified) return;
  state.unavailableNotified = true;
  context.ui.notify('IAR 桥接不可用，当前输入已安全阻断。', 'error');
}

/** 读取并限制 input 事件的公开字段。 */
function readInputEvent(value: unknown): PiInputEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { text: '', source: 'interactive' };
  const record = value as Record<string, unknown>;
  const text = typeof record.text === 'string' ? record.text : '';
  const source = record.source === 'rpc' || record.source === 'extension' ? record.source : 'interactive';
  return { text, source };
}

/** 扩展会话状态只保存映射、当前待确认 actionId 和故障告知标记。 */
type ExtensionState = { iarSessionId: string | undefined; pendingActionId: string | undefined; isAvailable: boolean; unavailableNotified: boolean };

const MAX_DISPLAY_CHARS = 4096;
