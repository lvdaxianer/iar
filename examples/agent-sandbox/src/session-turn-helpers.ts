/** 会话确认回复、选择输入和 Pi bridge 判定的无状态辅助。
 * 这些函数只通过显式上下文访问会话能力，不持有第二份会话状态。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
import type { ActionDefinition, ActionResult, BehaviorContext } from '@iar/contracts';
import type { PluginDescriptor } from '@iar/plugins';
import { ModelResponseLimitError, trackModelResponseLimit } from './models/model-transport.js';
import { resolveSandboxTraceId } from './safe-log.js';
import type { SandboxSessionReplies } from './session-replies.js';
import { hasVerifiedFactsForFollowUp } from './session-clarification.js';
import type { ConfirmResult, RouteEvidence, TurnResult } from './session-types.js';

/** 构造待确认期间的 bridge 澄清结果。 */
export function pendingBridgeResult(): TurnResult {
  return { status: 'clarification', reply: '当前有待确认的 IAR 操作，请使用 /iar-confirm 或 /iar-cancel。', route: { status: 'rejected', reasonCode: 'pending_confirmation', semanticIntent: 'unknown', semanticConfidence: 0 }, reasonCode: 'pending_confirmation' };
}

/** 判断路由未命中是否真的是普通 Pi 输入。 */
export function canPassThrough(context: BehaviorContext, evidence: RouteEvidence, selectedDescriptor: PluginDescriptor | undefined): boolean {
  return selectedDescriptor === undefined && evidence.semanticIntent === 'unknown' && context.pending.status !== 'required' && !hasVerifiedFactsForFollowUp(context, evidence);
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
