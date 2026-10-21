/** 会话确认回复、选择输入和 Pi bridge 判定的无状态辅助。
 * 这些函数只通过显式上下文访问会话能力，不持有第二份会话状态。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
import type { ActionDefinition, ActionResult, BehaviorContext } from '@iar/contracts';
import type { PluginDescriptor } from '@iar/plugins';
import { ModelResponseLimitError, trackModelResponseLimit } from './models/model-transport.js';
import type { PiAgentDelegate } from './models/pi-agent-delegate.js';
import { resolveSandboxTraceId, writeSafeLog } from './safe-log.js';
import type { SandboxSessionReplies } from './session-replies.js';
import { hasVerifiedFactsForFollowUp } from './session-clarification.js';
import type { ConfirmResult, PassThroughCapabilityContext, RouteEvidence, TurnResult } from './session-types.js';

/** 构造待确认期间的 bridge 澄清结果。 */
export function pendingBridgeResult(): TurnResult {
  return { status: 'clarification', reply: '当前有待确认的 IAR 操作，请使用 /iar-confirm 或 /iar-cancel。', route: { status: 'rejected', reasonCode: 'pending_confirmation', semanticIntent: 'unknown', semanticConfidence: 0 }, reasonCode: 'pending_confirmation' };
}

/** 判断路由未命中是否真的是普通 Pi 输入。 */
export function canPassThrough(context: BehaviorContext, evidence: RouteEvidence, selectedDescriptor: PluginDescriptor | undefined): boolean {
  return selectedDescriptor === undefined && evidence.semanticIntent === 'unknown' && context.pending.status !== 'required' && !hasVerifiedFactsForFollowUp(context, evidence);
}

/** 运行 Pi 委托并统一故障处理；返回 undefined 表示调用方继续走 IAR 兜底。
 * @param delegate - 当前会话的 Pi 委托
 * @param userText - 用户输入
 * @param onDelta - 流式增量回调
 * @returns 完整回复或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
export async function runPiAgentDelegate(delegate: PiAgentDelegate, userText: string, onDelta: (delta: string) => void, functionDescriptors: readonly PluginDescriptor[] = []): Promise<string | undefined> {
  try {
    return await delegate.run(userText, onDelta, functionDescriptors);
  } catch {
    writeSafeLog({ level: 'warn', event: 'sandbox.pi_agent', outcome: 'agent_unavailable' });
    return undefined;
  }
}

/** 处理未命中路由的分派：bridge 模式返回 pass_through，网页会话交给进程内 Pi Agent。
 * eligibility 不满足、委托缺失或故障时返回 undefined，调用方继续走 IAR 兜底。
 * @param context - 委托、历史写入、bridge 语义与 eligibility 判定所需输入
 * @returns pass_through、agent 结果或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
export async function resolveNoMatchTurn(context: { piAgent: PiAgentDelegate | undefined; pushMessages: (userText: string, reply: string) => void; passThroughOnNoMatch: boolean; userText: string; evidence: RouteEvidence; behaviorContext: BehaviorContext; selectedDescriptor: PluginDescriptor | undefined; functionDescriptors: readonly PluginDescriptor[] }): Promise<TurnResult | undefined> {
  const { piAgent, pushMessages, passThroughOnNoMatch, userText, evidence, behaviorContext, selectedDescriptor, functionDescriptors } = context;
  if (!canPassThrough(behaviorContext, evidence, selectedDescriptor)) return undefined;
  if (passThroughOnNoMatch) return evidence.status === 'noul' ? { status: 'pass_through', route: evidence, capabilityContext: passThroughCapabilityContext(functionDescriptors) } : undefined;
  if (!piAgent) return undefined;
  const reply = await runPiAgentDelegate(piAgent, userText, () => undefined, functionDescriptors);
  if (reply === undefined) return undefined;
  pushMessages(userText, reply);
  return { status: 'agent', reply, route: evidence };
}

/** 只把能力目录中的公开描述投影给 pass-through 下游模型。 */
function passThroughCapabilityContext(functionDescriptors: readonly PluginDescriptor[]): PassThroughCapabilityContext {
  return { functionDescriptors: functionDescriptors.map(({ functionId, pluginId, description, actionTypes }) => ({ functionId, pluginId, description, actionTypes })) };
}

/** 把 IAR 已处理轮次以备注写入 Pi 上下文；Pi 自己处理的轮次不重复记录。
 * 返回原结果，方便调用方直接返回。
 * @param piAgent - 当前会话的 Pi 委托，可能未注入
 * @param text - 原始用户输入或确认标记
 * @param result - 本轮对话或确认结果
 * @returns 传入的结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
export function recordAgentExchange<T extends TurnResult | ConfirmResult>(piAgent: PiAgentDelegate | undefined, text: string, result: T): T {
  if (!piAgent || result.status === 'agent') return result;
  if (!('reply' in result) || typeof result.reply !== 'string' || result.reply.length === 0) return result;
  piAgent.recordHandledTurn(text.trim(), result.reply);
  return result;
}

/** 解析当前启用且授权的候选键。 */
export function resolveSelection(descriptors: PluginDescriptor[], text: string, context: BehaviorContext): { descriptor?: PluginDescriptor; invalid: boolean; reasonCode: string } {
  if (context.clarification?.mode !== 'selection' || context.pending.kind !== 'selection' || context.pending.status !== 'required') return { invalid: false, reasonCode: 'none' };
  const trimmed = text.trim();
  const descriptor = descriptors.find((item) => item.candidateKey === trimmed);
  if (descriptor) return { descriptor, invalid: false, reasonCode: 'none' };
  return trimmed.startsWith('candidate-') ? { invalid: true, reasonCode: 'selection_invalid' } : { invalid: false, reasonCode: 'selection_replaced' };
}

/** 对过期或非法候选选择 fail-closed。 */
export function rejectSelection(replies: Pick<SandboxSessionReplies, 'pushMessages'>, userText: string, reasonCode: string): TurnResult {
  const reply = '这个选项已失效，请从当前列出的选项中重新选择。';
  replies.pushMessages(userText, reply);
  return { status: 'clarification', reply, route: { status: 'rejected', reasonCode, semanticIntent: 'unknown', semanticConfidence: 0 }, reasonCode };
}

/** 为已确认执行的动作生成回复，超限时保留成功状态。 */
export async function finishConfirmedAction(context: { replies: SandboxSessionReplies; projector: { current(): BehaviorContext }; recentMessages: Array<{ role: string; text: string }>; functionDescriptors: PluginDescriptor[]; turnCount: number }, action: ActionDefinition, actionResult: ActionResult): Promise<ConfirmResult> {
  const reply = await trackModelResponseLimit(() => context.replies.generateReply({ traceId: resolveSandboxTraceId(`trace-sandbox-confirm-${String(context.turnCount)}`), runId: action.runId, userText: '（确认执行）', behaviorContext: context.projector.current(), recentMessages: context.recentMessages, functionDescriptors: context.functionDescriptors, action, actionResult })).catch((error: unknown) => {
    if (!(error instanceof ModelResponseLimitError)) throw error;
    return undefined;
  });
  if (reply === undefined) return { status: 'executed', reply: '动作已执行，但模型回复超限且不完整，请勿重复执行。', actionResult, reasonCode: 'model_response_too_large' };
  context.replies.pushAssistantMessage(reply);
  return { status: 'executed', reply, actionResult };
}
