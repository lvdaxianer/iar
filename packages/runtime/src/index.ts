/**
 * 暴露 BehaviorContext 投影、事件重放、关键哈希和 Action 幂等门禁。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export * from './context-projector.js';
export * from './fact-relation.js';
export * from './compaction.js';
export type { CompactionResult } from '@iar/contracts';
export * from './replay.js';
export * from './action-idempotency.js';
export * from './routing.js';
