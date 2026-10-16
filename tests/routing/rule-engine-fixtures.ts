/**
 * 提供规则引擎测试共享的规则构造器和 JSON facts。
 *
 * 测试 fixture 固定 Function/Plugin 归属和基础审计元数据。
 * 所有对象都只包含内存 JSON 值，不依赖外部服务或宿主进程。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { SCHEMA_VERSIONS, type RuleExpression } from '../../packages/contracts/src/index.js';
import type { FunctionRule, PluginCandidate, PluginRule, RuleEvaluationFacts } from '../../packages/rule-engine/src/index.js';

const BASE_RULE = {
  // 基础版本固定，确保所有测试结果可回放。
  schemaVersion: SCHEMA_VERSIONS.rule,
  version: '1.0.0',
  priority: 100,
  specificity: 1,
  unknownFieldPolicy: 'match_none' as const
};

/**
 * 创建测试用 FunctionRule。
 *
 * @param functionId - Function 候选标识
 * @param expression - 规则表达式
 * @param overrides - 规则和输出元数据覆盖项
 * @returns 完整 FunctionRule
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function functionRule(functionId: string, expression: RuleExpression, overrides: Partial<FunctionRule['rule']> & Partial<Omit<FunctionRule, 'rule' | 'functionId'>> = {}): FunctionRule {
  // overrides 同时支持规则排序字段和候选输出元数据。
  const { priority, specificity, unknownFieldPolicy, ruleId, version, ...metadata } = overrides;
  return {
    functionId,
    requiredSlots: ['subject.id'],
    riskLevel: 'low',
    evidenceCodes: ['test.rule'],
    ...metadata,
    rule: {
      ...BASE_RULE,
      ruleId: ruleId ?? `rule-${functionId}`,
      version: version ?? BASE_RULE.version,
      target: 'function',
      priority: priority ?? BASE_RULE.priority,
      specificity: specificity ?? BASE_RULE.specificity,
      unknownFieldPolicy: unknownFieldPolicy ?? BASE_RULE.unknownFieldPolicy,
      expression
    }
  };
}

/**
 * 创建测试用 PluginRule。
 *
 * @param pluginId - 插件候选标识
 * @param expression - 规则表达式
 * @param overrides - 规则和输出元数据覆盖项
 * @returns 完整 PluginRule
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function pluginRule(pluginId: string, expression: RuleExpression, overrides: Partial<PluginRule['rule']> & Partial<Omit<PluginRule, 'rule' | 'pluginId'>> = {}): PluginRule {
  // Plugin fixture 默认绑定 service.stop，单测只覆盖变化的门禁字段。
  const { priority, specificity, unknownFieldPolicy, ruleId, version, ...metadata } = overrides;
  return {
    pluginId,
    functionId: 'dip.service.stop',
    requiredCapabilities: ['service.stop'],
    ...metadata,
    rule: {
      ...BASE_RULE,
      ruleId: ruleId ?? `rule-${pluginId}`,
      version: version ?? BASE_RULE.version,
      target: 'plugin',
      priority: priority ?? BASE_RULE.priority,
      specificity: specificity ?? BASE_RULE.specificity,
      unknownFieldPolicy: unknownFieldPolicy ?? BASE_RULE.unknownFieldPolicy,
      expression
    }
  };
}

/**
 * 创建测试用 PluginHost 候选快照。
 *
 * @param pluginId - 插件标识
 * @param overrides - 生命周期和授权覆盖项
 * @returns 插件候选
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function pluginCandidate(pluginId: string, overrides: Partial<PluginCandidate> = {}): PluginCandidate {
  // 候选快照只表达宿主状态，不携带真实插件执行句柄。
  return { pluginId, functionId: 'dip.service.stop', enabled: true, authorized: true, capabilities: ['service.stop'], ...overrides };
}

/** 当前路由规则使用的确定性 JSON facts。 */
export const facts: RuleEvaluationFacts = {
  semantic: { intent: 'service.stop', action: 'stop' },
  subject: { id: 'test1', metadata: { a: 1, b: 2 }, labels: ['dip', 'service'] },
  context: { workflow: { status: 'running' } }
};
