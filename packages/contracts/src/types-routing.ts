/**
 * 定义路由规则和工作流状态机类型。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { JsonValue } from './types-base.js';

/** 规则匹配的对象边界。 */
export type RuleTarget = 'function' | 'plugin';

/** 规则遇到未知字段时的处理策略。 */
export type UnknownFieldPolicy = 'reject' | 'ignore' | 'match_none';

/** 工作流实例的运行状态。 */
export type WorkflowStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

/** 规则中的原子条件。 */
export type RuleCondition = {
  // field 从结构化上下文读取。
  field: string;
  // operator 保持匹配语义可解释。
  operator: 'equals' | 'contains' | 'in' | 'exists' | 'matches';
  // value 只能是可序列化 JSON 数据。
  value?: JsonValue;
};

/** ALL、ANY、NONE 三种递归规则表达式。 */
export type RuleExpression =
  | { all: RuleExpression[] }
  | { any: RuleExpression[] }
  | { none: RuleExpression[] }
  | { condition: RuleCondition };

/** 可解释、可版本化的 Function/Plugin 路由规则。 */
export type RuleDefinition = {
  // 规则 Schema 版本用于回放。
  schemaVersion: typeof import('./versions.js').SCHEMA_VERSIONS.rule;
  // ruleId 是规则实例稳定标识。
  ruleId: string;
  // version 固定匹配语义。
  version: string;
  // target 区分 Function 边界和功能内插件筛选。
  target: RuleTarget;
  // priority 先解决显式冲突。
  priority: number;
  // specificity 再解决特异性冲突。
  specificity: number;
  // 未知字段策略必须显式声明。
  unknownFieldPolicy: UnknownFieldPolicy;
  expression: RuleExpression;
};

/** 工作流状态转移。 */
export type WorkflowTransition = {
  // event 是状态机稳定触发事件。
  event: string;
  // from 是允许的当前状态。
  from: string;
  // to 是确定性的下一状态。
  to: string;
};

/** 本地确定性工作流定义。 */
export type WorkflowDefinition = {
  // Workflow Schema 版本用于恢复。
  schemaVersion: typeof import('./versions.js').SCHEMA_VERSIONS.workflow;
  // workflowId 是编排定义稳定标识。
  workflowId: string;
  // version 固定状态机行为。
  version: string;
  // description 供宿主展示和审计。
  description: string;
  // states 是允许恢复的状态全集。
  states: string[];
  initialState: string;
  terminalStates: string[];
  // transitions 定义显式状态边。
  transitions: WorkflowTransition[];
};
