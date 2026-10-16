/**
 * 暴露本地受限 DecisionProvider 和统一结果校验。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { DecisionResult } from '@iar/contracts';
import type { DecisionCandidate } from './types.js';
import { providerFailureResult, shouldInvokeProvider, validateDecisionOutput } from './validation.js';
import type { DecisionProvider, DecisionRequest, DecisionResponseFactory } from './types.js';

export * from './types.js';
export { validateDecisionOutput } from './validation.js';
export * from './model-profile.js';

/**
 * 用确定性响应工厂模拟未来 DecisionProvider。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class MockDecisionProvider implements DecisionProvider {
  private readonly responseFactory: DecisionResponseFactory;
  private lastProviderError: unknown = undefined;

  /**
   * 创建确定性 Mock provider。
   *
   * @param responseFactory - 根据受限请求返回原始输出
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(responseFactory: DecisionResponseFactory) {
    this.responseFactory = responseFactory;
  }

  /**
   * 暴露最近一次 Mock provider 异常，供测试和本地诊断使用。
   *
   * @returns 最近一次异常或 undefined
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public get lastError(): unknown {
    return this.lastProviderError;
  }

  /**
   * 先处理空候选/并列候选，再校验 provider 原始输出。
   *
   * @param request - 有限候选和阈值约束
   * @returns 版本化、边界受控的 DecisionResult
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public decide(request: DecisionRequest): DecisionResult {
    // 空候选、无效请求和并列候选在 provider 之前收敛为稳定结果。
    if (!shouldInvokeProvider(request)) return validateDecisionOutput(request, undefined);
    let raw: unknown;
    try {
      raw = this.responseFactory(freezeRequest(request));
    } catch (error) {
      // 保留异常上下文供调试器捕获，同时对外只返回稳定的 provider_failed。
      this.lastProviderError = error;
      return providerFailureResult(request);
    }
    return validateDecisionOutput(request, raw);
  }
}

/**
 * 创建只读请求快照，避免 provider 修改调用方候选。
 *
 * @param request - 原始决策请求
 * @returns 只读候选请求
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function freezeRequest(request: DecisionRequest): DecisionRequest {
  return { ...request, candidates: Object.freeze(request.candidates.map(freezeCandidate)) };
}

/**
 * 复制并冻结候选及其可选数组，隔离 provider 的嵌套修改。
 *
 * @param candidate - 原始候选
 * @returns 深一层隔离后的只读候选
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function freezeCandidate(candidate: DecisionCandidate): DecisionCandidate {
  const frozen: DecisionCandidate = { ...candidate };
  // 复制槽位数组，防止 provider 反向修改调用方输入。
  if (candidate.requiredSlots !== undefined) frozen.requiredSlots = Object.freeze([...candidate.requiredSlots]);
  // 复制证据数组，防止 provider 反向修改调用方输入。
  if (candidate.evidenceCodes !== undefined) frozen.evidenceCodes = Object.freeze([...candidate.evidenceCodes]);
  return Object.freeze(frozen);
}
