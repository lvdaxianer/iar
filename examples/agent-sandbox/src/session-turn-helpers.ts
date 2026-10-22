/** 会话确认回复、选择输入和 Pi bridge 判定的无状态辅助。
 * 这些函数只通过显式上下文访问会话能力，不持有第二份会话状态。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
import type { ActionDefinition, ActionResult, BehaviorContext } from '@iar/contracts';
import type { PluginDescriptor } from '@iar/plugins';
import { ModelResponseLimitError, trackModelResponseLimit } from './models/model-transport.js';
import type { PiAgentDelegate } from './models/pi-agent-delegate.js';
import { logRouteContractFailure, logRouteDecision, resolveSandboxTraceId, writeSafeLog } from './safe-log.js';
import type { SandboxSessionReplies } from './session-replies.js';
import { hasVerifiedFactsForFollowUp } from './session-clarification.js';
import type { ConfirmResult, ExecuteTurnOutcome, OperationKind, PassThroughCapabilityContext, RouteEvidence, TurnResult } from './session-types.js';
import type { SemanticFrame } from '@iar/runtime';
import type { TurnTimingTracker } from './turn-timing.js';

/**
 * 识别语义帧是否不足以进入业务路由，并写出每个被跳过的阶段。
 *
 * 这里只判断结构字段是否存在，不猜测业务含义；缺失字段交给回复模型或后续澄清流程处理。
 * @param frame - 已通过 Schema 校验的语义帧
 * @param traceId - 当前回合链路标识
 * @param timing - 当前回合阶段计时器
 * @returns 不完整时的路由证据，否则返回 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-23
 */
export function gateIncompleteSemanticFrame(frame: SemanticFrame, traceId: string, timing: TurnTimingTracker, userText: string): RouteEvidence | undefined {
  const missingField = frame.intent === 'unknown' ? 'intent' : frame.action === 'unknown' ? 'action' : undefined;
  if (missingField === undefined || !isLikelyBusinessRequest(userText)) return undefined;
  const evidence: RouteEvidence = { status: 'semantic_incomplete', reasonCode: 'semantic_incomplete', semanticIntent: frame.intent, semanticConfidence: frame.confidence };
  evidence.missingField = missingField;
  for (const stage of ['route.propose', 'route.select', 'action.execute'] as const) {
    timing.skip(stage);
    logRouteDecision(traceId, { stage, status: 'skipped', reasonCode: 'semantic_incomplete', execution: 'blocked' });
  }
  return evidence;
}

/**
 * 只作为安全门禁判断输入是否声称要处理业务，不负责选择 Function 或 Plugin。
 * @param userText - 当前用户输入
 * @returns 是否应阻止不完整帧进入业务路由
 * @author lvdaxianer@yeah.net
 * @date 2026-10-23
 */
function isLikelyBusinessRequest(userText: string): boolean {
  return /帮我|请|我要|执行|创建|提交|调整|修改|查询|查看|列出|导出|删除|重启|停止|转人工|工单|限流|告警|报表|权限/u.test(userText);
}

/**
 * 为不完整业务请求生成固定澄清，不经过 Response Model，也不授予执行权限。
 * @param evidence - 语义门禁产生的路由证据
 * @returns 有缺失字段时的澄清文本
 * @author lvdaxianer@yeah.net
 * @date 2026-10-23
 */
export function semanticIncompleteClarification(evidence: RouteEvidence): string | undefined {
  if (evidence.reasonCode !== 'semantic_incomplete') return undefined;
  if (evidence.missingField === 'action') return `已识别目标 Function「${evidence.semanticIntent}」，但还缺少操作类型。请说明是查询、创建、更新、删除还是执行；当前不会执行任何动作。`;
  if (evidence.missingField === 'intent') return '我识别到这是业务请求，但还不能确定目标 Function。请补充要处理的对象或能力，并说明要查询、创建、更新、删除还是执行；当前不会执行任何动作。';
  return '当前请求缺少路由所需信息，请补充目标和操作类型；当前不会执行任何动作。';
}

/** 将动作阶段的契约失败投影到公开证据并写入安全诊断日志。 */
export function applyRouteDiagnostic(evidence: RouteEvidence, traceId: string, outcome: ExecuteTurnOutcome): void {
  if (outcome.status !== 'clarification' && outcome.status !== 'failed') return;
  if (outcome.diagnostic === undefined) return;
  evidence.status = 'clarification';
  evidence.reasonCode = outcome.diagnostic.reasonCode;
  if (outcome.diagnostic.expectedOperation !== undefined) evidence.expectedOperation = outcome.diagnostic.expectedOperation;
  if (outcome.diagnostic.actualOperation !== undefined) evidence.actualOperation = outcome.diagnostic.actualOperation;
  logRouteContractFailure(traceId, outcome.diagnostic);
}

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
export async function finishConfirmedAction(context: { replies: SandboxSessionReplies; projector: { current(): BehaviorContext }; recentMessages: Array<{ role: string; text: string }>; functionDescriptors: PluginDescriptor[]; turnCount: number }, action: ActionDefinition, actionResult: ActionResult, operationKind: OperationKind): Promise<ConfirmResult> {
  const reply = await trackModelResponseLimit(() => context.replies.generateReply({ traceId: resolveSandboxTraceId(`trace-sandbox-confirm-${String(context.turnCount)}`), runId: action.runId, userText: '（确认执行）', behaviorContext: context.projector.current(), recentMessages: context.recentMessages, functionDescriptors: context.functionDescriptors, action, actionResult, operationKind })).catch((error: unknown) => {
    if (!(error instanceof ModelResponseLimitError)) throw error;
    return undefined;
  });
  if (reply === undefined) return { status: 'executed', reply: '动作已执行，但模型回复超限且不完整，请勿重复执行。', actionResult, reasonCode: 'model_response_too_large' };
  if (reply.length > 0) context.replies.pushAssistantMessage(reply);
  return { status: 'executed', reply, actionResult };
}
