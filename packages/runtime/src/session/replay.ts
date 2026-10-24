/**
 * 提供事件序列的确定性 BehaviorContext 重放入口。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { SCHEMA_VERSIONS, validateContract, type BehaviorContext, type EventEnvelope } from '@iar/contracts';
import { BehaviorContextProjector, createInitialContext } from './context-projector.js';

/** 输入事件不满足同一事实源边界时抛出的重放错误。 */
export class ReplayValidationError extends Error {
  /** 创建携带稳定错误信息的重放校验错误。 */
  public constructor(message: string) {
    super(message);
    this.name = 'ReplayValidationError';
  }
}

/**
 * 将相同事件序列投影为相同的行为状态。
 *
 * @param events - 同一运行的有序事件
 * @param initial - 可选的可信初始上下文
 * @returns 重放后的行为上下文
 * @throws ReplayValidationError 当事件边界不一致时
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function replayEvents(events: readonly EventEnvelope[], initial?: BehaviorContext): BehaviorContext {
  validateReplayEvents(events);
  const projector = new BehaviorContextProjector(initial ?? createInitialContext(events[0]?.runId), events[0]?.runId);
  for (const event of events) {
    try {
      projector.apply(event);
    } catch (error) {
      throw new ReplayValidationError(error instanceof Error ? error.message : `事件投影失败: ${event.eventId}`);
    }
  }
  const result = projector.current();
  if (!validateContract('behaviorContext', result).ok) throw new ReplayValidationError('重放结果不是合法 BehaviorContext');
  return result;
}

/** 校验重放事件属于同一版本、运行和唯一事实序列。 */
function validateReplayEvents(events: readonly EventEnvelope[]): void {
  const seen = new Set<string>();
  let runId: string | undefined;
  let occurredAt = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    const result = validateContract('event', event);
    if (!result.ok || event.schemaVersion !== SCHEMA_VERSIONS.event) {
      throw new ReplayValidationError(`事件契约无效: ${event.eventId}`);
    }
    if (seen.has(event.eventId)) throw new ReplayValidationError(`事件重复: ${event.eventId}`);
    if (runId !== undefined && event.runId !== runId) throw new ReplayValidationError('重放事件不能混合多个 runId');
    const timestamp = Date.parse(event.occurredAt);
    if (!Number.isFinite(timestamp)) throw new ReplayValidationError(`事件时间无效: ${event.eventId}`);
    if (occurredAt > timestamp) throw new ReplayValidationError('重放事件时间顺序无效');
    runId = event.runId;
    occurredAt = timestamp;
    seen.add(event.eventId);
  }
}
