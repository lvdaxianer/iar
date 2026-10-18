/**
 * 提供 agent sandbox 的 FunctionRule 和 PluginRule 静态规则集。
 *
 * 十个 FunctionRule 以 semantic.intent equals 各 functionId 为条件，
 * intent 即 functionId，覆盖企业数据平台的十个子系统；requiredSlots
 * 全部放宽（session 侧 buildActionInput 负责槽位缺失澄清），riskLevel
 * 与 requiresConfirmation 按各 Function 的默认操作类型定：默认操作为
 * read 的函数免确认，默认操作为 action 的函数（ticket.create、
 * human.transfer）声明 high + 需确认。十个 PluginRule 声明对应插件
 * 所需的最小 capability 集合。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
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

/** 单个 Function 规则声明所需的元数据。 */
type FunctionRuleSpec = {
  functionId: string;
  riskLevel: 'low' | 'high';
  requiresConfirmation: boolean;
  evidenceCode: string;
};

/** 十个 Function 的规则元数据，riskLevel 按默认操作类型定。 */
const FUNCTION_RULE_SPECS: readonly FunctionRuleSpec[] = [
  { functionId: 'knowledge.query', riskLevel: 'low', requiresConfirmation: false, evidenceCode: 'sandbox.intent.knowledge_query' },
  { functionId: 'dip.manage', riskLevel: 'low', requiresConfirmation: false, evidenceCode: 'sandbox.intent.dip_manage' },
  { functionId: 'job.monitor', riskLevel: 'low', requiresConfirmation: false, evidenceCode: 'sandbox.intent.job_monitor' },
  { functionId: 'api.gateway', riskLevel: 'low', requiresConfirmation: false, evidenceCode: 'sandbox.intent.api_gateway' },
  { functionId: 'dataset.query', riskLevel: 'low', requiresConfirmation: false, evidenceCode: 'sandbox.intent.dataset_query' },
  { functionId: 'report.center', riskLevel: 'low', requiresConfirmation: false, evidenceCode: 'sandbox.intent.report_center' },
  { functionId: 'system.status', riskLevel: 'low', requiresConfirmation: false, evidenceCode: 'sandbox.intent.system_status' },
  { functionId: 'account.privilege', riskLevel: 'low', requiresConfirmation: false, evidenceCode: 'sandbox.intent.account_privilege' },
  { functionId: 'ticket.create', riskLevel: 'high', requiresConfirmation: true, evidenceCode: 'sandbox.intent.ticket_create' },
  { functionId: 'human.transfer', riskLevel: 'high', requiresConfirmation: true, evidenceCode: 'sandbox.intent.human_transfer' }
];

/** 单个 Plugin 规则声明所需的元数据。 */
type PluginRuleSpec = {
  pluginId: string;
  functionId: string;
  requiredCapabilities: readonly string[];
  evidenceCode: string;
};

/** 十个 Plugin 的规则元数据，风险与确认策略与对应 Function 对齐。 */
const PLUGIN_RULE_SPECS: readonly PluginRuleSpec[] = [
  { pluginId: 'knowledge-query-v1', functionId: 'knowledge.query', requiredCapabilities: ['knowledge.read'], evidenceCode: 'sandbox.plugin.knowledge_query' },
  { pluginId: 'dip-manage-v1', functionId: 'dip.manage', requiredCapabilities: ['dip.read', 'dip.control'], evidenceCode: 'sandbox.plugin.dip_manage' },
  { pluginId: 'job-monitor-v1', functionId: 'job.monitor', requiredCapabilities: ['job.read'], evidenceCode: 'sandbox.plugin.job_monitor' },
  { pluginId: 'api-gateway-v1', functionId: 'api.gateway', requiredCapabilities: ['gateway.read', 'gateway.control'], evidenceCode: 'sandbox.plugin.api_gateway' },
  { pluginId: 'dataset-query-v1', functionId: 'dataset.query', requiredCapabilities: ['dataset.read'], evidenceCode: 'sandbox.plugin.dataset_query' },
  { pluginId: 'report-center-v1', functionId: 'report.center', requiredCapabilities: ['report.read', 'report.export'], evidenceCode: 'sandbox.plugin.report_center' },
  { pluginId: 'system-status-v1', functionId: 'system.status', requiredCapabilities: ['status.read'], evidenceCode: 'sandbox.plugin.system_status' },
  { pluginId: 'account-privilege-v1', functionId: 'account.privilege', requiredCapabilities: ['account.read', 'account.grant'], evidenceCode: 'sandbox.plugin.account_privilege' },
  { pluginId: 'ticket-create-v1', functionId: 'ticket.create', requiredCapabilities: ['ticket.read', 'ticket.write'], evidenceCode: 'sandbox.plugin.ticket_create' },
  { pluginId: 'human-transfer-v1', functionId: 'human.transfer', requiredCapabilities: ['human.transfer'], evidenceCode: 'sandbox.plugin.human_transfer' }
];

/** 按 Function 元数据构造 FunctionRule，requiredSlots 全部放宽。 */
function toFunctionRule(spec: FunctionRuleSpec): FunctionRule {
  return {
    functionId: spec.functionId,
    riskLevel: spec.riskLevel,
    requiresConfirmation: spec.requiresConfirmation,
    evidenceCodes: [spec.evidenceCode],
    rule: {
      ...BASE_RULE,
      ruleId: `rule-${spec.functionId.replace(/\./g, '-')}`,
      target: 'function',
      expression: intentEquals(spec.functionId)
    }
  };
}

/** 按 Plugin 元数据与对应 Function 风险策略构造 PluginRule。 */
function toPluginRule(spec: PluginRuleSpec): PluginRule {
  const functionSpec = FUNCTION_RULE_SPECS.find((item) => item.functionId === spec.functionId);
  return {
    pluginId: spec.pluginId,
    functionId: spec.functionId,
    requiredCapabilities: [...spec.requiredCapabilities],
    requiresConfirmation: functionSpec?.requiresConfirmation ?? true,
    riskLevel: functionSpec?.riskLevel ?? 'high',
    evidenceCodes: [spec.evidenceCode],
    rule: {
      ...BASE_RULE,
      ruleId: `rule-plugin-${spec.pluginId.replace(/-/g, '_')}`,
      target: 'plugin',
      expression: intentEquals(spec.functionId)
    }
  };
}

/** sandbox 使用的全部 Function 规则（十个子系统）。 */
export const sandboxFunctionRules: readonly FunctionRule[] = FUNCTION_RULE_SPECS.map(toFunctionRule);

/** sandbox 使用的全部 Plugin 规则（十个子系统）。 */
export const sandboxPluginRules: readonly PluginRule[] = PLUGIN_RULE_SPECS.map(toPluginRule);

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
