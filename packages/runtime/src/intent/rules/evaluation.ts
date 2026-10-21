/**
 * 兼容导出受限规则引擎的表达式、候选和插件门禁能力。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export { evaluateExpression } from './expression-evaluator.js';
export { evaluateCandidateRules } from './candidate-ranking.js';
export { createPluginGuards } from './plugin-guards.js';
