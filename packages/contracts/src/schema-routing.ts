/**
 * 定义路由规则与本地工作流的公共 Schema。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { Type } from '@sinclair/typebox';
import { SCHEMA_VERSIONS } from './versions.js';
import { JsonValueSchema } from './schema-primitives.js';

/** 规则原子条件的比较字段和操作符。 */
export const RuleConditionSchema = Type.Object({
  // field 从 SemanticFrame 或 BehaviorContext 读取。
  field: Type.String({ minLength: 1 }),
  // operator 保持规则匹配可解释。
  operator: Type.Union([
    Type.Literal('equals'),
    Type.Literal('contains'),
    Type.Literal('in'),
    Type.Literal('exists'),
    Type.Literal('matches')
  ]),
  // value 只能是可序列化 JSON 数据。
  value: Type.Optional(JsonValueSchema)
}, { additionalProperties: false });

/** ALL、ANY、NONE 规则表达式的递归结构。 */
export const RuleExpressionSchema = Type.Recursive((self) => Type.Union([
  // ALL 要求所有子条件命中。
  Type.Object({ all: Type.Array(self, { minItems: 1 }) }, { additionalProperties: false }),
  // ANY 允许任一子条件命中。
  Type.Object({ any: Type.Array(self, { minItems: 1 }) }, { additionalProperties: false }),
  // NONE 用于排除误路由。
  Type.Object({ none: Type.Array(self, { minItems: 1 }) }, { additionalProperties: false }),
  // condition 是递归树的叶子。
  Type.Object({ condition: RuleConditionSchema }, { additionalProperties: false })
]));

/** 可解释、可版本化的 Function/Plugin 路由规则。 */
export const RuleDefinitionSchema = Type.Object({
  // 规则版本用于回放和冲突审计。
  schemaVersion: Type.Literal(SCHEMA_VERSIONS.rule),
  // ruleId 是规则实例的稳定标识。
  ruleId: Type.String({ minLength: 1 }),
  // version 固定规则行为。
  version: Type.String({ pattern: '^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$' }),
  // target 区分 Function 边界和功能内插件筛选。
  target: Type.Union([Type.Literal('function'), Type.Literal('plugin')]),
  // priority 先解决显式优先级冲突。
  priority: Type.Integer(),
  // specificity 再解决规则特异性冲突。
  specificity: Type.Integer({ minimum: 0 }),
  // 未知字段策略必须显式声明。
  unknownFieldPolicy: Type.Union([
    Type.Literal('reject'),
    Type.Literal('ignore'),
    Type.Literal('match_none')
  ]),
  // expression 是可解释的匹配树。
  expression: RuleExpressionSchema
}, { additionalProperties: false });

/** 工作流状态转移，保证恢复时状态边界明确。 */
export const WorkflowTransitionSchema = Type.Object({
  // event 是状态机的稳定触发事件。
  event: Type.String({ minLength: 1 }),
  // from 是允许的当前状态。
  from: Type.String({ minLength: 1 }),
  // to 是确定性的下一状态。
  to: Type.String({ minLength: 1 })
}, { additionalProperties: false });

/** 本地确定性工作流定义。 */
export const WorkflowDefinitionSchema = Type.Object({
  // 工作流版本用于恢复和迁移。
  schemaVersion: Type.Literal(SCHEMA_VERSIONS.workflow),
  // workflowId 是编排定义的稳定标识。
  workflowId: Type.String({ minLength: 1 }),
  // version 固定状态机行为。
  version: Type.String({ pattern: '^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$' }),
  // description 供宿主展示和审计。
  description: Type.String({ minLength: 1 }),
  // states 是允许恢复到的状态集合。
  states: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  // initialState 是新实例的确定性起点。
  initialState: Type.String({ minLength: 1 }),
  // terminalStates 定义工作流收敛边界。
  terminalStates: Type.Array(Type.String({ minLength: 1 })),
  // transitions 定义显式状态边。
  transitions: Type.Array(WorkflowTransitionSchema)
}, { additionalProperties: false });
