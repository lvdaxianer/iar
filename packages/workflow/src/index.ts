/** 暴露本地确定性 Workflow、Policy Gate 和 confirmation scope 能力。 @author lvdaxianer@yeah.net @date 2026-10-17 */
// 公共入口只导出稳定契约，内部辅助函数保持包内可见。
export * from './types.js';
export * from './policy-gate.js';
export * from './local-workflow.js';
export * from './event-log.js';
// Workflow 入口同时暴露状态、策略、执行和事件回放边界。
