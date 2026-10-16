/**
 * 提供 Temporal-compatible durable runtime 的无副作用 v1 contract adapter。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { validateContract } from '@iar/contracts';
import type { WorkflowRequest, WorkflowResult, WorkflowRun } from '@iar/workflow';
import type { WorkflowRuntimeContract, WorkflowRuntimeOptions } from './types.js';

/**
 * 记录 durable adapter 的选择和版本，但不执行尚未实现的副作用。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class ContractWorkflowRuntime implements WorkflowRuntimeContract {
  /** 适配器名称。 */
  public readonly adapterName: string;
  /** 适配器契约版本。 */
  public readonly adapterVersion: 'v1';

  /**
   * 创建一个只验证 contract 的 durable runtime。
   * @param options - 适配器名称和版本
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(options: WorkflowRuntimeOptions) {
    // 适配器配置必须在创建时锁定到 v1，禁止运行时降级或升级解释。
    if (!isValidOptions(options)) throw new Error('durable_adapter_configuration_invalid');
    this.adapterName = options.adapterName;
    this.adapterVersion = options.adapterVersion;
  }

  /**
   * 验证请求并稳定拒绝未接入持久化执行器的调用。
   * @param request - 未信任的 Workflow 请求
   * @returns 输入错误或 adapter 尚未实现的稳定结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public start(request: WorkflowRequest): WorkflowResult<WorkflowRun> {
    // 非法请求在进入持久化执行前稳定拒绝。
    if (!isValidRequest(request)) return { ok: false, reasonCode: 'workflow_request_invalid' };
    return { ok: false, reasonCode: 'durable_adapter_not_implemented' };
  }
}

/**
 * 校验 adapter 配置的运行时形状和固定版本。
 * @param options - 未信任的 adapter 配置
 * @returns 是否为合法 v1 配置
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isValidOptions(options: unknown): options is WorkflowRuntimeOptions {
  try {
    return isRecord(options) && typeof options.adapterName === 'string' && options.adapterName.length > 0 && options.adapterVersion === 'v1';
  } catch {
    // 恶意 getter 或 revoked Proxy 不得在构造阶段泄露原始异常。
    return false;
  }
}

/**
 * 校验 Workflow 请求和公共 WorkflowDefinition Schema。
 * @param request - 未信任的启动请求
 * @returns 是否为稳定可读取的请求
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isValidRequest(request: unknown): request is WorkflowRequest {
  try {
    // 请求外围字段必须完整，避免从不完整输入读取 Schema。
    if (!isRecord(request) || typeof request.runId !== 'string' || request.runId.length === 0 || !isRecord(request.definition)) return false;
    return validateContract('workflow', request.definition).ok;
  } catch {
    // 恶意 getter、Proxy 或 Schema 校验异常都按输入无效处理。
    return false;
  }
}

/**
 * 判断值是否为非数组对象。
 * @param value - 待判断值
 * @returns 是否为普通对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
