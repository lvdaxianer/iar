/**
 * 暴露 durable WorkflowRuntime 的稳定公共入口。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { DurableWorkflowEngine } from './durable-runtime-engine.js';
import type { DurableWorkflowRuntimeOptions } from './types.js';

/**
 * Temporal-compatible durable runtime facade。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class DurableWorkflowRuntime extends DurableWorkflowEngine {
  /**
   * 创建 durable runtime facade。
   * @param options - adapter、准入需求和持久化 store
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(options: DurableWorkflowRuntimeOptions) {
    super(options);
  }
}
