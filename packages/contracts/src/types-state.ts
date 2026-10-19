/**
 * 定义 Action、Decision、BehaviorContext 和 Event 类型。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { JsonValue, RiskLevel } from './types-base.js';
import type { WorkflowStatus } from './types-routing.js';

/** 待执行的副作用 Action。 */
export type ActionDefinition = {
  // Action Schema 版本用于结果解析。
  schemaVersion: typeof import('./versions.js').SCHEMA_VERSIONS.action;
  // actionId 标识一次副作用尝试。
  actionId: string;
  // runId 绑定可恢复运行实例。
  runId: string;
  // Function 和 Plugin 在副作用前固定。
  functionId: string;
  // pluginId 固定执行实现。
  pluginId: string;
  // 幂等键防止重试产生第二次副作用。
  idempotencyKey: string;
  // input 是可重放 JSON 载荷。
  input: JsonValue;
  // riskLevel 供 Policy Gate 使用。
  riskLevel: RiskLevel;
  // confirmationRequired 不能被执行器临时改变。
  confirmationRequired: boolean;
};

/** Action 的可审计执行结果。 */
export type ActionResult = {
  // 结果与请求共享 Action Schema 版本。
  schemaVersion: typeof import('./versions.js').SCHEMA_VERSIONS.action;
  // actionId 关联原始请求。
  actionId: string;
  // status 区分执行阶段和终态。
  status: 'accepted' | 'in_progress' | 'succeeded' | 'failed' | 'cancelled';
  // output 是可审计 JSON 结果。
  output?: JsonValue;
  // errorCode 是稳定错误码。
  errorCode?: string;
};

/** 决策对象的类型。 */
export type DecisionType = 'semantic.extract' | 'function.select' | 'plugin.select' | 'policy.evaluate' | 'response.generate';

/** 结构化 Decision 结果，不能直接授予执行权限。 */
export type DecisionResult = {
  // Decision Schema 版本决定字段解释。
  schemaVersion: typeof import('./versions.js').SCHEMA_VERSIONS.decision;
  // decisionType 固定决策边界。
  decisionType: DecisionType;
  // decisionVersion 标识适配器或规则版本。
  decisionVersion: string;
  // status 区分选择、澄清、拒绝和 noul。
  status: 'choice' | 'needs_clarification' | 'rejected' | 'noul';
  // choice 只在可执行选择时出现。
  choice?: string;
  // score 用于阈值校验。
  score?: number;
  // reasonCode 使理由可审计。
  reasonCode: string;
  // candidateIds 保留有限候选集合。
  candidateIds: string[];
};

/** BehaviorContext 的主语及其不可变来源。 */
export type SubjectReference = {
  // type 描述主语的领域类型。
  type: string;
  // id 是恢复主语的稳定标识。
  id: string;
  // status 区分已解析和待解析。
  status: 'resolved' | 'unresolved';
  // source 保留引用的事实来源。
  source: 'input' | 'context' | 'event' | 'plugin';
  // sourceEventId 指向解析结果事件。
  sourceEventId?: string;
};

/** BehaviorContext 中带状态的槽位值。 */
export type SlotValue = {
  // value 是可重放的槽位数据。
  value: JsonValue;
  // status 区分待补齐、已解析和已确认。
  status: 'unresolved' | 'resolved' | 'confirmed';
  // sourceEventId 记录槽位来源。
  sourceEventId?: string;
};

/** BehaviorContext 当前行为路由。 */
export type BehaviorRoute = {
  // functionId 是不可越过的功能边界。
  functionId?: string;
  // pluginId 是重试时固定的实现版本。
  pluginId?: string;
};

/** BehaviorContext 当前工作流位置。 */
export type BehaviorWorkflow = {
  // workflowId 绑定当前编排定义。
  workflowId?: string;
  // currentStep 是恢复执行的步骤边界。
  currentStep: string;
  // status 区分运行、等待和终态。
  status: WorkflowStatus;
};

/** 主循环当前等待的输入类型。 */
export type PendingInput = {
  // kind 标识主循环正在等待哪类输入。
  kind: 'slot' | 'selection' | 'confirmation' | 'input';
  // status 记录输入是否已收到。
  status: 'required' | 'received' | 'none';
};

/** 高风险动作的确认状态及绑定范围。 */
export type ConfirmationState = {
  // state 是动作确认的唯一来源。
  state: 'not_required' | 'required' | 'confirmed' | 'rejected';
  // scopeHash 把确认绑定到动作和参数。
  scopeHash?: string;
  // confirmedAt 保留确认发生时间。
  confirmedAt?: string;
};

/** 可信事实允许保存的有界 JSON 原子值。 */
export type TrustedFactValue = string | number | boolean | null;

/** 成功输出中可供后续模型读取的可信事实。 */
export type TrustedFact = {
  /** 事实值，必须来自公开输出字段。 */
  value: TrustedFactValue;
  /** 固定为 verified，避免把推测或失败结果当成事实。 */
  status: 'verified';
  /** 产生事实的不可变事件。 */
  sourceEventId: string;
  /** 事实所属 Function。 */
  functionId: string;
  /** 事实所属 Plugin。 */
  pluginId: string;
  /** 输出契约中公开的字段名。 */
  field: string;
};

/** 已校验、可恢复但不可执行的上下文摘要。 */
export type ContextSummary = {
  /** 摘要正文，长度由 BehaviorContext Schema 限制。 */
  text: string;
  /** 摘要生成协议版本。 */
  version: string;
  /** 生成摘要的不可变压缩事件。 */
  eventId: string;
};

/** 不可变事实投影出的当前 BehaviorContext。 */
export type BehaviorContext = {
  // BehaviorContext 版本决定投影和重放方式。
  schemaVersion: typeof import('./versions.js').SCHEMA_VERSIONS.behaviorContext;
  // subject 保留当前操作对象及来源。
  subject: SubjectReference;
  // intent 是语义提取后的稳定意图。
  intent: string;
  // action 保留动作名称和执行阶段。
  action: { name: string; status: 'proposed' | 'resolved' | 'executed' | 'failed' };
  // route 保留 Function 和已固定 Plugin。
  route: BehaviorRoute;
  // slots 记录已解析和待确认参数。
  slots: Record<string, SlotValue>;
  // workflow 记录可恢复的状态机位置。
  workflow: BehaviorWorkflow;
  // pending 记录当前等待的用户输入。
  pending: PendingInput;
  // confirmation 记录确认范围和状态。
  confirmation: ConfirmationState;
  // facts 只保存成功输出中的有限、可追溯事实。
  facts?: Record<string, TrustedFact>;
  // summary 只用于辅助理解和恢复，不授予模型执行权限。
  summary?: ContextSummary;
  // 幂等键贯穿一次 Action 提交和重试。
  idempotencyKey: string;
  // 关键字段哈希绑定最后事实事件。
  integrity: { criticalFieldHash: string; lastEventId: string };
};

/** IAR 有限事件名称。 */
export type EventName =
  | 'plugin.discovered'
  | 'plugin.validated'
  | 'plugin.installed'
  | 'plugin.enabled'
  | 'plugin.disabled'
  | 'plugin.draining'
  | 'plugin.unloaded'
  | 'plugin.rejected'
  | 'decision.created'
  | 'workflow.started'
  | 'workflow.transitioned'
  | 'action.started'
  | 'action.completed'
  | 'action.failed'
  | 'context.compacted'
  | 'context.compaction_failed';

/** EventLog 的不可变事件外壳。 */
export type EventEnvelope = {
  // Event Schema 版本决定投影器如何解析。
  schemaVersion: typeof import('./versions.js').SCHEMA_VERSIONS.event;
  // eventId 是不可变事件的唯一标识。
  eventId: string;
  // eventName 决定事件对应的投影动作。
  eventName: EventName;
  // occurredAt 保留事实发生时间。
  occurredAt: string;
  // runId 关联一次可恢复运行。
  runId: string;
  // correlationId 关联业务链路。
  correlationId: string;
  // causationId 关联直接前置事实。
  causationId?: string;
  // payload 只允许可重放 JSON。
  payload: JsonValue;
};
