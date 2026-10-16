/**
 * 定义受限 DecisionProvider 的候选、约束和 provider 接口。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { DecisionResult, DecisionType, RiskLevel } from '@iar/contracts';

/** 当前本地决策模块允许的两类候选选择。 */
export type SelectionDecisionType = Extract<DecisionType, 'function.select' | 'plugin.select'>;

/** 规则引擎输出给 DecisionProvider 的最小候选投影。 */
export type DecisionCandidate = {
  // 候选标识必须来自规则引擎的有限集合。
  candidateId: string;
  // priority 和 specificity 用于判断候选是否可区分。
  priority: number;
  specificity: number;
  // 这些字段只供决策解释，不授予任何权限。
  requiredSlots?: readonly string[];
  riskLevel?: RiskLevel;
  evidenceCodes?: readonly string[];
};

/** Mock 或未来真实 provider 接收的结构化决策约束。 */
export type DecisionRequest = {
  // 决策阶段固定为 Function 或 Plugin 选择。
  decisionType: SelectionDecisionType;
  // provider 版本由调用方固定，输出必须保持一致。
  decisionVersion: string;
  // 最低可执行置信度阈值。
  threshold: number;
  // 有限候选集合，不允许 provider 扩展。
  candidates: readonly DecisionCandidate[];
};

/** provider 原始输出工厂，返回值必须经过运行时校验。 */
export type DecisionResponseFactory = (request: DecisionRequest) => unknown;

/** 本地 provider 的统一决策接口。 */
export interface DecisionProvider {
  /**
   * 在有限候选上产生可验证决策结果。
   *
   * @param request - 结构化候选和阈值约束
   * @returns 版本化 DecisionResult
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  decide(request: DecisionRequest): DecisionResult;
}
