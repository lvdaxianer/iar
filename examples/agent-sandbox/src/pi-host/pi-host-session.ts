/** 进程内 Pi 宿主会话：按真实集成链路把每轮输入先交给 @iar/pi-bridge 扩展，
 * IAR 未命中（continue）时才交给进程内 Pi Agent 回答。
 * 网页端与 IAR Agent Sandbox 共用同一套界面资源复刻 “Pi 宿主 + IAR 前置意图路由层”，
 * 扩展、bridge client 与 Pi 委托均复用正式集成代码。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
import { createIarExtension, IarBridgeClient, type BridgeCapabilityDescriptor, type BridgeConfirmResponse, type BridgeInputResponse, type BridgeInputStreamHandlers, type BridgePendingAction, type BridgeReplySource, type BridgeTimingSummary, type IarBridgeClientLike, type PiExtensionAPI, type PiExtensionContext, type PiInputResult } from '@iar/pi-bridge';
import { createPiAgentDelegate, type PiAgentDelegate } from '../models/pi-agent-delegate.js';
import type { SandboxMode } from '../session-types.js';

/** 单次 IAR 路由的公开摘要，用于页面展示拦截证据。 */
export type PiHostRouteInfo = { disposition: string; reasonCode: string; semanticIntent: string; semanticConfidence: number; functionId?: string; pluginId?: string; operationKind?: 'read' | 'action'; expectedOperation?: string; actualOperation?: string; replySource?: BridgeReplySource };

/** 会话对外事件；全部由 PiHostSession 在确定性时机触发。 */
export type PiHostSessionEvents = {
  /** IAR custom entry（handled/clarification/awaiting_confirmation/确认结果）。 */
  onEntry?: (entry: { customType: string; data: unknown }) => void;
  /** 扩展通知（桥接不可用、无待确认等），与 Pi TUI 的 notify 对应。 */
  onNotify?: (message: string, type: 'info' | 'warning' | 'error') => void;
  /** 每次 bridge input 后的路由证据，先于对应 entry 触发。 */
  onRoute?: (route: PiHostRouteInfo) => void;
  /**
   * 每轮输入结束时的总耗时和各阶段耗时。
   */
  onTiming?: (timing: BridgeTimingSummary) => void;
  /** 待确认动作变化；null 表示当前没有待确认。 */
  onConfirm?: (pending: BridgePendingAction | null) => void;
  /** Pi Agent 流式增量（仅未命中输入）。 */
  onPiDelta?: (delta: string) => void;
  /** Pi Agent 单轮结束，回传完整回复。 */
  onPiDone?: (reply: string) => void;
  /** IAR 最终 response.generate 的原始 reasoning 增量。 */
  onIarReasoningDelta?: (delta: string) => void;
  /** IAR 最终 response.generate 的答案增量。 */
  onIarDelta?: (delta: string) => void;
};

/** Pi 宿主会话配置。 */
export type PiHostSessionOptions = {
  /** 模拟的 Pi 会话标识，bridge 侧映射键。 */
  sessionId: string;
  /** Pi Agent 大脑模式：scripted 离线模板，brain 真实模型。 */
  mode: SandboxMode;
  /** Agent 创建时配置的总体提示词。 */
  systemPrompt?: string;
  /** 覆盖 bridge client（测试注入假桥）。 */
  client?: IarBridgeClientLike;
  /** bridge 地址；缺省取 IAR_PI_BRIDGE_URL 或本地 8787。 */
  bridgeUrl?: string;
  /** 覆盖进程内 Pi 委托（测试注入探针）。 */
  piAgent?: PiAgentDelegate;
  /** 页面事件回调。 */
  events?: PiHostSessionEvents;
};

/** 单轮输入处置结果。 */
export type PiHostInputResult = { action: 'handled' | 'continue' };

/** 可观测 client：在转发响应的同时提取路由证据和待确认状态。 */
function observeClient(client: IarBridgeClientLike, hooks: { input?: (response: BridgeInputResponse) => void; confirm?: (response: BridgeConfirmResponse) => void; stream?: BridgeInputStreamHandlers }): IarBridgeClientLike {
  return {
    openSession: (request) => client.openSession(request),
    input: async (sessionId, text) => { const response = client.inputStream ? await client.inputStream(sessionId, text, hooks.stream ?? {}) : await client.input(sessionId, text); hooks.input?.(response); return response; },
    confirm: async (sessionId, actionId, accepted) => { const response = await client.confirm(sessionId, actionId, accepted); hooks.confirm?.(response); return response; },
    state: (sessionId) => client.state(sessionId)
  };
}

/** 模拟 Pi 宿主的网页会话：IAR 前置拦截 + Pi Agent 兜底回答。 */
export class PiHostSession {
  private readonly handlers = new Map<string, (event: unknown, context: PiExtensionContext) => Promise<unknown> | unknown>();
  private readonly commands = new Map<string, { handler: (args: string, context: PiExtensionContext) => Promise<void> }>();
  private readonly delegate: PiAgentDelegate;
  private readonly events: PiHostSessionEvents;
  private readonly context: PiExtensionContext;
  /** 当前 pass-through 请求携带的有界能力目录。 */
  private passThroughDescriptors: BridgeCapabilityDescriptor[] = [];
  /** 同一会话的轮次串行，保持与 Pi 单会话输入队列一致的语义。 */
  private chain: Promise<unknown> = Promise.resolve();
  /** 当前轮收集的 entry，handled 后以备注形式写进 Pi 委托上下文。 */
  private collectedEntries: Array<{ customType: string; data: unknown }> = [];

  public constructor(private readonly options: PiHostSessionOptions) {
    this.events = options.events ?? {};
    this.delegate = options.piAgent ?? createPiAgentDelegate({ mode: options.mode, sessionId: options.sessionId, ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }) });
    const baseClient = options.client ?? new IarBridgeClient({ baseUrl: options.bridgeUrl ?? process.env.IAR_PI_BRIDGE_URL ?? 'http://127.0.0.1:8787' });
    const client = observeClient(baseClient, {
      input: (response) => { this.passThroughDescriptors = response.disposition === 'pass_through' ? response.capabilityContext?.functionDescriptors ?? [] : []; this.publishRoute(response); if (response.timing) this.events.onTiming?.(response.timing); this.events.onConfirm?.(response.pending ?? null); },
      confirm: (response) => { this.events.onConfirm?.(response.pending ?? null); },
      stream: { onReasoningDelta: (delta) => this.events.onIarReasoningDelta?.(delta), onDelta: (delta) => this.events.onIarDelta?.(delta) }
    });
    const pi: PiExtensionAPI = {
      on: (event, handler) => { this.handlers.set(event, handler); },
      registerCommand: (name, definition) => { this.commands.set(name, definition); },
      appendEntry: (customType, data) => { const entry = { customType, data }; this.collectedEntries.push(entry); this.events.onEntry?.(entry); },
      registerEntryRenderer: () => {}
    };
    this.context = {
      sessionManager: { getSessionId: () => options.sessionId },
      ui: { notify: (message, type) => { this.events.onNotify?.(message, type ?? 'info'); } },
      // tui 模式让 entry 只走 appendEntry，notify 专用于错误与不可用提示，避免页面双份展示。
      mode: 'tui'
    };
    this.chain = this.chain.then(() => createIarExtension({ client })(pi));
  }

  /** 等待扩展注册完成并建立 Pi→IAR 会话映射；失败在扩展内收敛为不可用。 */
  public async start(): Promise<void> {
    await this.chain;
    await this.handlers.get('session_start')?.({}, this.context);
  }

  /** 处理一轮用户输入：先走 IAR input hook，未命中再交给 Pi Agent。 */
  public handleUserInput(text: string): Promise<PiHostInputResult> {
    const run = this.chain.then(() => this.processInput(text));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** 执行 /iar-confirm 或 /iar-cancel，回到 IAR 权威会话。 */
  public confirm(accepted: boolean): Promise<boolean> {
    const run = this.chain.then(async () => {
      const command = this.commands.get(accepted ? 'iar-confirm' : 'iar-cancel');
      if (!command) return false;
      await command.handler('', this.context);
      return true;
    });
    this.chain = run.catch(() => false);
    return run;
  }

  /** 模拟 Pi 会话关闭：触发扩展 shutdown 并清空 Pi 委托上下文。 */
  public async dispose(): Promise<void> {
    await this.chain;
    await this.handlers.get('session_shutdown')?.({}, this.context);
    this.delegate.reset();
  }

  /** 单轮输入处理：handled 直接结束，continue 由进程内 Pi Agent 回答。 */
  private async processInput(text: string): Promise<PiHostInputResult> {
    // 每轮先清空，避免桥接失败或旧版响应缺少字段时把上一轮能力目录带入下一轮。
    this.passThroughDescriptors = [];
    const inputHandler = this.handlers.get('input');
    if (!inputHandler) return { action: 'continue' };
    this.collectedEntries = [];
    const result = (await inputHandler({ text, source: 'interactive' }, this.context)) as PiInputResult | void;
    if (result?.action === 'handled') {
      // 与真实 Pi 一致：用户消息和 IAR 结果都进入 Pi 侧 transcript。
      const handled = this.collectedEntries.at(-1)?.data;
      if (typeof handled === 'object' && handled !== null && 'content' in handled && typeof (handled as { content: unknown }).content === 'string') {
        this.delegate.recordHandledTurn(text, (handled as { content: string }).content);
      }
      return { action: 'handled' };
    }
    try {
      const reply = await this.delegate.run(text, (delta) => { this.events.onPiDelta?.(delta); }, this.passThroughDescriptors);
      this.events.onPiDone?.(reply);
    } catch {
      this.events.onNotify?.('Pi Agent 本轮回答失败。', 'error');
      this.events.onPiDone?.('');
    }
    return { action: 'continue' };
  }

  /** 把 bridge 输入响应投影为路由摘要事件。 */
  private publishRoute(response: BridgeInputResponse): void {
    const route = response.route;
    this.events.onRoute?.({
      disposition: response.disposition,
      reasonCode: route?.reasonCode ?? 'none',
      semanticIntent: route?.semanticIntent ?? 'unknown',
      semanticConfidence: route?.semanticConfidence ?? 0,
      ...(route?.functionId === undefined ? {} : { functionId: route.functionId }),
      ...(route?.pluginId === undefined ? {} : { pluginId: route.pluginId }),
      ...(route?.operationKind === undefined ? {} : { operationKind: route.operationKind }),
      ...(route?.expectedOperation === undefined ? {} : { expectedOperation: route.expectedOperation }),
      ...(route?.actualOperation === undefined ? {} : { actualOperation: route.actualOperation }),
      ...(response.replySource === undefined ? {} : { replySource: response.replySource })
    });
  }
}
