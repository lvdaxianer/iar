/**
 * 暴露 durable WorkflowRuntime 的公共版本化能力。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
// 基础类型定义保持在最外层，供 adapter 和 store 共享。
export * from './types.js';
// 准入策略保证短动作不被默认迁移到 durable 平台。
export * from './admission.js';
// contract adapter 提供无副作用的 v1 入口。
export * from './contract-runtime.js';
// store 暴露原子创建、CAS 更新和内存测试实现。
export * from './durable-store.js';
// facade 暴露 worker-loss resume、重试和幂等执行。
export * from './durable-runtime.js';
