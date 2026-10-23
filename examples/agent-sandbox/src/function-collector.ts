import { MAX_CLARIFICATION_LABEL_LENGTH, MAX_COLLECTION_ATTEMPTS, MAX_COLLECTION_CANDIDATES, type CollectionState, type PendingInput } from '@iar/contracts';
import type { PluginDescriptor } from '@iar/plugins';

/** Function 收集器的结构化输入，不包含自然语言匹配结果。 */
export type FunctionCollectionRequest = {
  pluginId?: string;
  functionId?: string;
  attempt: number;
};

/** Function 收集器的有限结果，不代表执行授权。 */
export type FunctionCollectionResult =
  | { status: 'selected'; descriptor: PluginDescriptor }
  | { status: 'collecting'; state: Extract<CollectionState, { kind: 'function' }>; options: NonNullable<PendingInput['options']> }
  | { status: 'empty'; reasonCode: 'function_candidates_empty' };

/**
 * 根据已授权的 PluginDescriptor 生成 Function 选择或确定性单选结果。
 * 只使用 pluginId/functionId/candidateKey 等结构化标识，不读取业务关键词。
 *
 * @param descriptors - PluginHost 投影出的当前候选快照
 * @param request - 模型已经返回的结构化归属信息
 * @returns 唯一 Function、有限澄清选项或稳定空结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-23
 */
export function collectFunctionCandidates(descriptors: readonly PluginDescriptor[], request: FunctionCollectionRequest): FunctionCollectionResult {
  if (!Number.isSafeInteger(request.attempt) || request.attempt < 1 || request.attempt > MAX_COLLECTION_ATTEMPTS) return { status: 'empty', reasonCode: 'function_candidates_empty' };
  const scoped = descriptors.filter((descriptor) => matchesScope(descriptor, request));
  const candidates = uniqueCandidates(scoped, request.functionId);
  if (candidates.length === 0) return { status: 'empty', reasonCode: 'function_candidates_empty' };
  if (candidates.length === 1) return { status: 'selected', descriptor: candidates[0]! };
  return collectingResult(candidates, request);
}

/** 判断候选是否属于已知 Plugin/Function 范围。 */
function matchesScope(descriptor: PluginDescriptor, request: FunctionCollectionRequest): boolean {
  return (request.pluginId === undefined || descriptor.pluginId === request.pluginId)
    && (request.functionId === undefined || descriptor.functionId === request.functionId);
}

/** 去除同一候选键的重复投影，并保留注册表的稳定顺序。 */
function uniqueCandidates(descriptors: readonly PluginDescriptor[], functionId?: string): PluginDescriptor[] {
  const seen = new Set<string>();
  const candidates: PluginDescriptor[] = [];
  for (const descriptor of descriptors) {
    if (functionId !== undefined && descriptor.functionId !== functionId) continue;
    if (seen.has(descriptor.candidateKey)) continue;
    seen.add(descriptor.candidateKey);
    candidates.push(descriptor);
  }
  return candidates.slice(0, MAX_COLLECTION_CANDIDATES);
}

/** 将有限候选投影为可恢复状态和用户可理解的选择项。 */
function collectingResult(candidates: readonly PluginDescriptor[], request: FunctionCollectionRequest): FunctionCollectionResult {
  const candidateFunctionIds = [...new Set(candidates.map((candidate) => candidate.functionId))];
  const candidateKeys = candidates.map((candidate) => candidate.candidateKey);
  const options = candidates.map((candidate) => ({ key: candidate.candidateKey, label: candidate.description.slice(0, MAX_CLARIFICATION_LABEL_LENGTH) }));
  return {
    status: 'collecting',
    state: {
      kind: 'function',
      ...(request.pluginId === undefined ? {} : { pluginId: request.pluginId }),
      candidateFunctionIds,
      candidateKeys,
      reasonCode: request.functionId === undefined ? 'function_missing' : 'function_ambiguous',
      attempt: request.attempt
    },
    options
  };
}
