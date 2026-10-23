/**
 * 定义 Action、Decision、BehaviorContext 和 Event 类型。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { MAX_TRUSTED_FACT_KEY_LENGTH, type ActionType, type FunctionResponse, type JsonValue, type RiskLevel } from './types-base.js';
import type { WorkflowStatus } from './types-routing.js';

/** 最近消息窗口允许的最大消息数量。 */
export const MAX_RECENT_MESSAGE_LIMIT = 20;

/** 未显式配置时使用的最近消息数量。 */
export const DEFAULT_RECENT_MESSAGE_LIMIT = 5;

/** 最近消息窗口允许的单条消息最大字符数。 */
export const MAX_RECENT_MESSAGE_CHARS = 2000;

/** 待选择候选和展示选项允许的最大数量。 */
export const MAX_CLARIFICATION_OPTIONS = 12;

/** 连续未解决状态允许保存的最大次数。 */
export const MAX_UNRESOLVED_STREAK = 8;

/** 连续无法解决时升级为动态候选选择的默认次数。 */
export const DEFAULT_UNRESOLVED_STREAK_THRESHOLD = 2;

/** 澄清原因和候选版本的长度边界。 */
export const MAX_CLARIFICATION_REASON_LENGTH = 120;
export const MAX_CANDIDATE_VERSION_LENGTH = 200;
export const MAX_CANDIDATE_KEY_LENGTH = 60;
export const MAX_CLARIFICATION_LABEL_LENGTH = 200;

/** 收集器状态的有界候选、字段和值上限。 */
export const MAX_COLLECTION_CANDIDATES = MAX_CLARIFICATION_OPTIONS;
export const MAX_COLLECTION_FIELDS = 32;
export const MAX_COLLECTION_ATTEMPTS = MAX_UNRESOLVED_STREAK;
export const MAX_COLLECTION_FIELD_LENGTH = MAX_TRUSTED_FACT_KEY_LENGTH;

/** 待解析引用原文和候选记录的边界。 */
export const MAX_PENDING_REFERENCE_TEXT_LENGTH = 300;
export const MAX_PENDING_REFERENCE_CANDIDATES = MAX_CLARIFICATION_OPTIONS;
export const MAX_PENDING_REFERENCE_OFFSET = 64;

/** 模型可声明的通用事实链关系。 */
export type PendingReferenceRelation = 'current' | 'previous' | 'next' | 'first' | 'last' | 'offset';

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
  // response 是已由 Function 校验的回复分流信封。
  response?: FunctionResponse;
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

/** 当前会话交给意图识别模型的有界路由范围。 */
export type RoutingScope = {
  /** 上一轮已选中的 Plugin，用于连续追问时提高复用优先级。 */
  activePluginId?: string;
  /** 本轮允许模型观察的 Plugin 标识，不是授权结果。 */
  candidatePluginIds: string[];
  /** 已选 Plugin 允许继续选择的固定动作集合。 */
  actionTypes: ActionType[];
  /** none 表示初始范围，reuse 表示沿用，replace 表示发生业务切换。 */
  continuation: 'none' | 'reuse' | 'replace';
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
  // options 是有限澄清选项，只用于下一轮理解，不授予执行权限。
  options?: Array<{ key: string; label: string }>;
};

/** 可随快照恢复、但不能授予执行权限的待解析事实引用。 */
export type PendingReference = {
  /** 用户原文中的指代片段。 */
  text: string;
  /** 模型归一化后的有序关系。 */
  relation: PendingReferenceRelation;
  /** 模型显式提供的不透明锚点。 */
  anchorRecordId?: string;
  /** offset 关系的有界相对位置。 */
  offset?: number;
  /** 运行时生成的有限候选记录 ID。 */
  candidateRecordIds: string[];
};

/** 最近消息窗口的有界策略，不保存消息原文。 */
export type RecentMessagePolicy = {
  /** 模型最多接收的最近消息数量。 */
  recentMessageLimit: number;
  /** 单条消息允许进入模型窗口的最大字符数。 */
  maxMessageChars: number;
};

/** 可随快照恢复的通用澄清状态。 */
export type ClarificationState = {
  /** 当前澄清模式，不代表任何执行授权。 */
  mode: 'none' | 'unresolved' | 'selection';
  /** 连续未解决次数，用于受控升级。 */
  unresolvedStreak: number;
  /** 最近一次稳定的未解决原因。 */
  reasonCode?: string;
  /** 产生候选键的注册表版本。 */
  candidateVersion?: string;
  /** 当前候选集合中的不透明键。 */
  candidateKeys?: string[];
};

/** 可恢复的通用 Function/参数收集状态，不代表授权或执行。 */
export type CollectionState =
  | {
      /** Function 尚未唯一确定。 */
      kind: 'function';
      /** 已确定 Plugin 时只在该 Plugin 范围内收集。 */
      pluginId?: string;
      /** 当前允许模型和用户选择的不透明 Function ID 集合。 */
      candidateFunctionIds: string[];
      /** 用于区分同名 Function 实现的不透明候选键集合。 */
      candidateKeys?: string[];
      /** 收集触发原因。 */
      reasonCode: 'function_missing' | 'function_ambiguous';
      /** 当前收集轮次。 */
      attempt: number;
    }
  | {
      /** Function 已确定，但输入参数还未满足 Schema。 */
      kind: 'parameters';
      /** 执行边界固定为该 Function。 */
      functionId: string;
      /** 可选的具体 Plugin 实现归属。 */
      pluginId?: string;
      /** 用于检测 Schema 演进。 */
      schemaVersion: string;
      /** 只保存已经通过字段边界的结构化值。 */
      collected: Record<string, JsonValue>;
      /** required 或其他契约要求但尚未满足的字段。 */
      missingFields: string[];
      /** 类型、枚举或未知字段校验失败的字段。 */
      invalidFields: string[];
      /** 同一字段出现互相冲突的值。 */
      conflictFields: string[];
      /** 当前收集轮次。 */
      attempt: number;
      /** 仅用于界面渲染的可选字段展示元数据，不授予执行权限。 */
      presentation?: Record<string, { label?: string; control?: 'text' | 'number' | 'boolean' | 'select' | 'multi-select' | 'object' }>;
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

/** 一次成功结果产生的有序可信事实记录。 */
export type VerifiedFactRecord = {
  /** 由运行时生成且不表达业务含义的稳定记录标识。 */
  recordId: string;
  /** 当前会话事实链中的单调序号。 */
  sequence: number;
  /** 产生该记录的不可变成功事件。 */
  sourceEventId: string;
  /** 事实所属 Function，只作为动态标识处理。 */
  functionId: string;
  /** 事实所属 Plugin，只作为动态标识处理。 */
  pluginId: string;
  /** Plugin 事实信封声明的有界原子值。 */
  values: Record<string, TrustedFactValue>;
  /** 来源事件发生时间。 */
  createdAt: string;
};

/** 可随 BehaviorContext 恢复的有界事实链。 */
export type VerifiedFactHistory = {
  /** 事实记录按 sequence 升序保存。 */
  records: VerifiedFactRecord[];
  /** 当前自然语言指代“这个”时使用的受信锚点。 */
  focusRecordId?: string;
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
  // routingScope 限制下一轮模型可观察的 Plugin/Action 范围。
  routingScope?: RoutingScope;
  // slots 记录已解析和待确认参数。
  slots: Record<string, SlotValue>;
  // workflow 记录可恢复的状态机位置。
  workflow: BehaviorWorkflow;
  // pending 记录当前等待的用户输入。
  pending: PendingInput;
  // recentMessagePolicy 只保存窗口策略，不复制原始消息。
  recentMessagePolicy?: RecentMessagePolicy;
  // clarification 保存连续未解决和待选择候选的结构化状态。
  clarification?: ClarificationState;
  // collection 保存 Function/参数收集的有限状态，不代表授权。
  collection?: CollectionState;
  // pendingReference 保存事实关系消歧所需的有限候选，不包含执行授权。
  pendingReference?: PendingReference;
  // confirmation 记录确认范围和状态。
  confirmation: ConfirmationState;
  // factHistory 保存成功输出中的有限、可追溯有序事实。
  factHistory?: VerifiedFactHistory;
  // facts 仅为旧快照读取兼容保留，新投影不再写入该 map。
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
  | 'message.received'
  | 'message.sent'
  | 'session.restored'
  | 'context.updated'
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
  | 'context.clarification.updated'
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
