/** 会话公开契约与内部处理结果。
 * 统一声明页面、HTTP 入口和会话组合根使用的类型。
 * 本文件只包含类型，不持有会话状态或运行时资源。
 * 会话原有导出路径继续由组合根重新导出。
 * 流式和普通回复使用同一个结果联合。
 * 动作结果独立于回复生成是否完整。
 * 路由证据及待确认摘要不携带会话管理器。
 * 保留现有状态与事件字段供兼容客户端读取。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import type { ActionDefinition, ActionResult, BehaviorContext, EventEnvelope, JsonValue, PendingReference, VerifiedFactRecord } from '@iar/contracts';
import type { DecisionBackend, SemanticFrame } from '@iar/runtime';
import type { PluginDescriptor } from '@iar/plugins';
import type { TurnTimingSummary } from './turn-timing.js';

/** sandbox 模式：brain 使用真实 LLM，scripted 使用离线假大脑。 */
export type SandboxMode = 'brain' | 'scripted';

/** sandbox 可选的决策 backend；默认保留 JEV 优先解析。 */
export type SandboxDecisionBackend = DecisionBackend;

/** 用户可观测的回复来源，值域与 Pi bridge 保持稳定。 */
export type ReplySource = 'direct_function' | 'response_model' | 'pi_agent' | 'none';

/** 运行时选中的 Function Operation 类型。 */
export type OperationKind = 'read' | 'action';

/** 路由证据摘要，供调试面板展示。 */
export type RouteEvidence = {
  /** 路由终态。 */
  status: string;
  /** 稳定原因码。 */
  reasonCode: string;
  /** 语义意图。 */
  semanticIntent: string;
  /** 语义置信度。 */
  semanticConfidence: number;
  /** Function 选择。 */
  functionId?: string;
  /** Plugin 选择。 */
  pluginId?: string;
  /** 选中的 Operation 类型，供回复来源和 Bridge 观察。 */
  operationKind?: OperationKind;
  /** Function 决策分数。 */
  functionScore?: number;
  /** Plugin 决策分数。 */
  pluginScore?: number;
  /** 语义抽取是否走了离线 ScriptedModelProvider 兜底重试。 */
  semanticFallback?: boolean;
};

/** pass-through 交给 Pi Host 的当前能力目录。 */
export type PassThroughCapabilityContext = { functionDescriptors: Array<Pick<PluginDescriptor, 'functionId' | 'pluginId' | 'description' | 'actionTypes'>> };

/** 待确认动作摘要，供前端渲染确认按钮。 */
export type PendingActionSummary = {
  /** Action 标识。 */
  actionId: string;
  /** 运行标识。 */
  runId: string;
  /** 目标 Function。 */
  functionId: string;
  /** 目标 Plugin。 */
  pluginId: string;
  /** 风险等级。 */
  riskLevel: string;
  /** 是否需要确认。 */
  confirmationRequired: boolean;
  /** Action 输入。 */
  input: JsonValue;
};

/** 单轮对话结果联合。 */
type TurnResultBody =
  | { status: 'pass_through'; route: RouteEvidence; capabilityContext: PassThroughCapabilityContext; replySource?: ReplySource }
  | { status: 'agent'; reply: string; route: RouteEvidence; replySource?: ReplySource }
  | { status: 'executed'; reply: string; route: RouteEvidence; actionResult: ActionResult; reasonCode?: string; replySource?: ReplySource }
  | { status: 'awaiting_confirmation'; reply: string; route: RouteEvidence; pending: PendingActionSummary; replySource?: ReplySource }
  | { status: 'clarification'; reply: string; route: RouteEvidence; reasonCode: string; disposition?: 'context_answered'; replySource?: ReplySource }
  | { status: 'failed'; reply: string; route: RouteEvidence; reasonCode: string; replySource?: ReplySource };

/**
 * 对外结果携带的单轮观测摘要，不包含正文或 thinking。
 */
export type TurnResult = TurnResultBody & { timing?: TurnTimingSummary };

/** 流式输出的阶段标识。 */
export type TurnStage = 'semantic' | 'route' | 'action' | 'response';

/** turnStreamed 下发的事件联合。 */
export type StreamEvent =
  | { type: 'stage'; stage: TurnStage }
  | { type: 'delta'; text: string }
  | { type: 'reasoningDelta'; text: string }
  | { type: 'timing'; summary: TurnTimingSummary }
  | { type: 'done'; result: TurnResult }
  | { type: 'error'; reasonCode: string; message: string };

/** 语义抽取阶段的内部结果联合。 */
export type ExtractFrameOutcome =
  | { ok: true; frame: SemanticFrame; semanticFallback: boolean }
  | { ok: false; route: RouteEvidence; reasonCode: string; reply: string };

/** 运行时解析出的历史引用，供回复模型读取已验证的单条事实。 */
export type ResolvedFactReference = {
  text: string;
  record: VerifiedFactRecord;
};

/** 历史引用未唯一收敛时返回的安全候选状态。 */
export type ReferenceResolution =
  | { ok: true; references: ResolvedFactReference[] }
  | { ok: false; reasonCode: 'reference_unresolved' | 'reference_ambiguous'; pendingReference?: PendingReference; candidates?: VerifiedFactRecord[] };

/** 单轮执行阶段的内部结果联合。 */
export type ExecuteTurnOutcome =
  | { status: 'executed'; action: ActionDefinition; actionResult: ActionResult; operationKind: OperationKind }
  | { status: 'awaiting_confirmation'; action: ActionDefinition; reply: string; operationKind: OperationKind }
  | { status: 'clarification'; reply: string; reasonCode: string }
  | { status: 'failed'; reply: string; reasonCode: string };

/** 确认操作结果联合。 */
export type ConfirmResult =
  | { status: 'executed'; reply: string; actionResult: ActionResult; reasonCode?: string; replySource?: ReplySource }
  | { status: 'cancelled'; reply: string; replySource?: ReplySource }
  | { status: 'failed'; reply: string; reasonCode: string; replySource?: ReplySource };

/** 按已校验的 Function 响应模式映射实际回复来源。 */
export function replySourceForActionResult(actionResult: ActionResult): ReplySource {
  if (actionResult.response?.mode === 'direct') return 'direct_function';
  if (actionResult.response?.mode === 'none') return 'none';
  return 'response_model';
}

/** 在公开会话边界补齐回复来源，兼容内部旧的结果构造路径。 */
export function withReplySource(result: TurnResult): TurnResult {
  if (result.replySource !== undefined) return result;
  if (result.status === 'pass_through' || result.status === 'agent') return { ...result, replySource: 'pi_agent' };
  if (result.status === 'executed') return { ...result, replySource: replySourceForActionResult(result.actionResult) };
  if (result.status === 'clarification') return { ...result, replySource: 'response_model' };
  return { ...result, replySource: 'none' };
}

/** 在确认边界补齐回复来源，避免确认响应缺少可观测来源。 */
export function withConfirmReplySource(result: ConfirmResult): ConfirmResult {
  if (result.replySource !== undefined) return result;
  if (result.status === 'executed') return { ...result, replySource: replySourceForActionResult(result.actionResult) };
  return { ...result, replySource: 'none' };
}

/** 上下文压缩结果。 */
export type CompactResult = {
  /** 压缩是否成功。 */
  ok: boolean;
  /** 稳定原因码。 */
  reasonCode?: string;
  /** 失败摘要或模型错误消息。 */
  error?: string;
  /** 压缩摘要。 */
  summary?: string;
  /** 压缩前关键字段哈希。 */
  hashBefore: string;
  /** 压缩后关键字段哈希。 */
  hashAfter: string;
  /** 写入的事件标识。 */
  eventId?: string;
};

/** 调试面板轮询的会话状态。 */
export type SandboxState = {
  /** 当前模式。 */
  mode: SandboxMode;
  /** 当前 BehaviorContext 投影。 */
  context: BehaviorContext;
  /** 全部事件。 */
  events: EventEnvelope[];
  /** 运行统计。 */
  stats: { turnCount: number; eventCount: number; compactCount: number; pendingConfirmation: boolean };
  /** 当前待确认动作。 */
  pending: PendingActionSummary | null;
};

