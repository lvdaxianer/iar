/**
 * 提供 agent sandbox 的 FunctionRule 和 PluginRule 静态规则集。
 *
 * 三个 FunctionRule 以 semantic.intent equals 各意图为条件，
 * requiredSlots、riskLevel 和 requiresConfirmation 与各示例插件的 Manifest policy 对齐；
 * 三个 PluginRule 声明对应插件所需的最小 capability 集合。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { SCHEMA_VERSIONS, type RuleExpression } from '@iar/contracts';
import type { FunctionRule, PluginRule } from '@iar/rule-engine';

/** sandbox 静态规则的公共版本和排序元数据。 */
const BASE_RULE = {
  schemaVersion: SCHEMA_VERSIONS.rule,
  version: '1.0.0',
  priority: 100,
  specificity: 1,
  unknownFieldPolicy: 'match_none' as const
};

/** knowledge.query 的低风险免确认 Function 规则。 */
export const knowledgeQueryFunctionRule: FunctionRule = {
  functionId: 'knowledge.query',
  requiredSlots: ['query'],
  riskLevel: 'low',
  requiresConfirmation: false,
  evidenceCodes: ['sandbox.intent.knowledge_query'],
  rule: {
    ...BASE_RULE,
    ruleId: 'rule-knowledge-query',
    target: 'function',
    expression: intentEquals('knowledge.query')
  }
};

/** ticket.create 的高风险需确认 Function 规则。 */
export const ticketCreateFunctionRule: FunctionRule = {
  functionId: 'ticket.create',
  requiredSlots: ['title', 'description', 'priority'],
  riskLevel: 'high',
  requiresConfirmation: true,
  evidenceCodes: ['sandbox.intent.ticket_create'],
  rule: {
    ...BASE_RULE,
    ruleId: 'rule-ticket-create',
    target: 'function',
    expression: intentEquals('ticket.create')
  }
};

/** human.transfer 的高风险需确认 Function 规则。 */
export const humanTransferFunctionRule: FunctionRule = {
  functionId: 'human.transfer',
  requiredSlots: ['reason', 'summary'],
  riskLevel: 'high',
  requiresConfirmation: true,
  evidenceCodes: ['sandbox.intent.human_transfer'],
  rule: {
    ...BASE_RULE,
    ruleId: 'rule-human-transfer',
    target: 'function',
    expression: intentEquals('human.transfer')
  }
};

/** knowledge-query-v1 插件规则，要求 knowledge.read 能力。 */
export const knowledgeQueryPluginRule: PluginRule = {
  pluginId: 'knowledge-query-v1',
  functionId: 'knowledge.query',
  requiredCapabilities: ['knowledge.read'],
  requiresConfirmation: false,
  riskLevel: 'low',
  evidenceCodes: ['sandbox.plugin.knowledge_query'],
  rule: {
    ...BASE_RULE,
    ruleId: 'rule-plugin-knowledge-query',
    target: 'plugin',
    expression: intentEquals('knowledge.query')
  }
};

/** ticket-create-v1 插件规则，要求 ticket.write 能力。 */
export const ticketCreatePluginRule: PluginRule = {
  pluginId: 'ticket-create-v1',
  functionId: 'ticket.create',
  requiredCapabilities: ['ticket.write'],
  requiresConfirmation: true,
  riskLevel: 'high',
  evidenceCodes: ['sandbox.plugin.ticket_create'],
  rule: {
    ...BASE_RULE,
    ruleId: 'rule-plugin-ticket-create',
    target: 'plugin',
    expression: intentEquals('ticket.create')
  }
};

/** human-transfer-v1 插件规则，要求 human.transfer 能力。 */
export const humanTransferPluginRule: PluginRule = {
  pluginId: 'human-transfer-v1',
  functionId: 'human.transfer',
  requiredCapabilities: ['human.transfer'],
  requiresConfirmation: true,
  riskLevel: 'high',
  evidenceCodes: ['sandbox.plugin.human_transfer'],
  rule: {
    ...BASE_RULE,
    ruleId: 'rule-plugin-human-transfer',
    target: 'plugin',
    expression: intentEquals('human.transfer')
  }
};

/** sandbox 使用的全部 Function 规则。 */
export const sandboxFunctionRules: readonly FunctionRule[] = [
  knowledgeQueryFunctionRule,
  ticketCreateFunctionRule,
  humanTransferFunctionRule
];

/** sandbox 使用的全部 Plugin 规则。 */
export const sandboxPluginRules: readonly PluginRule[] = [
  knowledgeQueryPluginRule,
  ticketCreatePluginRule,
  humanTransferPluginRule
];

/**
 * 构造 semantic.intent equals 条件表达式。
 *
 * @param intent - 目标意图
 * @returns 规则表达式
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function intentEquals(intent: string): RuleExpression {
  return { condition: { field: 'semantic.intent', operator: 'equals', value: intent } };
}
