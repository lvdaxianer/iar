/**
 * 提供 ServiceApi typed client 的 install/enable/disable/inspect/replay CLI。
 *
 * CLI 不直接访问 Workflow、PluginHost、数据库或网络；宿主注入 ServiceApi client。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { ServiceApiClient as _ServiceApiClient, ServiceApiRequest, ServiceApiResponse } from '@iar/adapters-service';

/*
 * CLI 只负责参数解析、Service operation 映射和安全 JSON 输出。
 * 它不创建 Fastify、Workflow、PluginHost 或数据库连接。
 * tenant/actor 始终来自显式 flag，授权继续由 Service API 执行。
 * manifest 只在 JSON.parse 后作为 payload 传输，不拼接 shell 命令。
 * 业务失败使用 exitCode 1，参数失败使用 exitCode 2。
 * stdout 只输出稳定 response，stderr 不输出原始参数或异常。
 * inspect 支持 plugin 摘要或 run 状态，不输出完整内部对象。
 * replay 只请求只读事件投影，不触发任何 Action executor。
 * 该模块保持无网络依赖，便于宿主注入 HTTP/Sidecar client。
 * 未知 flag 不进入 Service API。
 * 重复 flag 不采用最后写入值覆盖前值。
 * inspect 必须明确选择 plugin 或 run 其中一个目标。
 * 每个命令的允许参数集合由 flagsFor 固定返回。
 * payload 构造与 operation 映射分离，便于审计边界。
 * context 解析与 payload 解析互相独立。
 * 请求 ID 只使用稳定命令和租户标识。
 * parser helper 保持短小，避免隐藏未验证分支。
 * CLI 不承担鉴权职责，只传递明确的 actor/tenant。
 * 所有错误响应均为固定文本，不包含敏感输入。
 * 该入口可以被真正的 bin 包装而不改变协议语义。
 * transport client 由宿主注入，便于替换为 Sidecar HTTP。
 */

/** CLI 调用 Service API 的最小 client。 */
export type CliServiceClient = Pick<_ServiceApiClient, 'request'>;

/** CLI 执行结果，stdout/stderr 都是可安全输出的字符串。 */
export type CliResult = { exitCode: 0 | 1 | 2; stdout: string; stderr: string };

type CliCommand = 'install' | 'enable' | 'disable' | 'inspect' | 'replay';

/**
 * 解析命令并调用 ServiceApi，缺参使用 2，业务失败使用 1。
 *
 * @param argv - 不含 node/script 的 CLI 参数
 * @param client - 注入的 ServiceApi client
 * @returns 安全 stdout/stderr 和退出码
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export async function runCli(argv: readonly string[], client: CliServiceClient): Promise<CliResult> {
  const parsed = parseArguments(argv);
  if (!parsed.ok) return { exitCode: 2, stdout: '', stderr: parsed.message };
  try {
    const response = await client.request(parsed.request);
    if (response.error) return { exitCode: 1, stdout: JSON.stringify({ error: response.error }) + '\n', stderr: '' };
    return { exitCode: 0, stdout: JSON.stringify(response) + '\n', stderr: '' };
  } catch {
    return { exitCode: 1, stdout: '', stderr: 'CLI Service 请求失败\n' };
  }
}

/**
 * 把有限 CLI 参数转换为 Service API request，不把参数原样拼进错误。
 *
 * @param argv - 不含 node/script 的 CLI 参数
 * @returns Service request 或稳定参数错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function parseArguments(argv: readonly string[]): { ok: true; request: ServiceApiRequest } | { ok: false; message: string } {
  const command = argv[0];
  // 未知命令不能动态映射到 Service operation。
  if (!isCommand(command)) return { ok: false, message: 'CLI 命令无效\n' };
  const values = parseFlags(argv.slice(1), flagsFor(command));
  // 参数结构错误必须在建立授权上下文前返回。
  if (!values.ok) return values;
  const context = parseContext(values.value);
  // tenant/actor 缺失时不允许继续构造业务 payload。
  if (!context.ok) return context;
  const payload = parsePayload(command, values.value);
  // 命令 payload 不满足白名单时不调用 Service。
  if (!payload.ok) return payload;
  const operation = operationFor(command, values.value);
  return buildRequest(operation, context.value, payload.value);
}

/** @param command - 公开命令 @returns 允许的 flag 名称 @author lvdaxianer@yeah.net @date 2026-10-17 */
function flagsFor(command: CliCommand): readonly string[] {
  // install 只能携带 manifest。
  if (command === 'install') return ['tenant', 'actor', 'manifest'];
  // replay 只能携带 run。
  if (command === 'replay') return ['tenant', 'actor', 'run'];
  // inspect 允许 plugin 或 run，后续要求二选一。
  if (command === 'inspect') return ['tenant', 'actor', 'plugin', 'run'];
  return ['tenant', 'actor', 'plugin'];
}

/** @param argv - flag/value pairs @param allowed - 命令白名单 @returns 解析后的 flags 或稳定错误 @author lvdaxianer@yeah.net @date 2026-10-17 */
function parseFlags(argv: readonly string[], allowed: readonly string[]): { ok: true; value: Map<string, string> } | { ok: false; message: string } {
  // 参数必须成对出现，避免把孤立 flag 当成值。
  if (argv.length % 2 !== 0) return { ok: false, message: 'CLI 参数无效\n' };
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    // 在调用 client 前拒绝格式错误、未知和重复参数。
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--') || !allowed.includes(key.slice(2)) || values.has(key.slice(2))) return { ok: false, message: 'CLI 参数无效\n' };
    values.set(key.slice(2), value);
  }
  return { ok: true, value: values };
}

/** @param values - 已解析 flags @returns 显式 tenant/actor 上下文 @author lvdaxianer@yeah.net @date 2026-10-17 */
function parseContext(values: Map<string, string>): { ok: true; value: { tenantId: string; actorId: string } } | { ok: false; message: string } {
  const tenantId = values.get('tenant');
  const actorId = values.get('actor');
  // 两个授权标识缺一不可。
  return tenantId && actorId ? { ok: true, value: { tenantId, actorId } } : { ok: false, message: 'CLI 缺少租户参数\n' };
}

/** @param command - 公开命令 @param values - 已解析 flags @returns 有界 payload 或稳定错误 @author lvdaxianer@yeah.net @date 2026-10-17 */
function parsePayload(command: CliCommand, values: Map<string, string>): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (command === 'install') return parseManifest(values.get('manifest')); // install 只有一个 JSON payload。
  if (command === 'replay') return requiredPayload(values.get('run'), 'run', 'runId'); // replay 只读事件。
  if (command === 'enable' || command === 'disable') return requiredPayload(values.get('plugin'), 'plugin', 'pluginId'); // 生命周期操作只接收一个 plugin。
  // inspect 必须恰好选择一个目标。
  if (values.has('plugin') === values.has('run')) return { ok: false, message: 'CLI inspect 目标无效\n' };
  return values.has('plugin') ? requiredPayload(values.get('plugin'), 'plugin', 'pluginId') : requiredPayload(values.get('run'), 'run', 'runId');
}

/** @param value - manifest JSON 文本 @returns manifest 数据或稳定错误 @author lvdaxianer@yeah.net @date 2026-10-17 */
function parseManifest(value: string | undefined): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  // 缺少 manifest 时不尝试解析或调用 client。
  if (!value) return { ok: false, message: 'CLI 缺少 manifest 参数\n' };
  try {
    return { ok: true, value: { manifest: JSON.parse(value) as unknown } };
  } catch {
    // JSON parse 错误不回显 manifest 原文。
    return { ok: false, message: 'CLI manifest JSON 无效\n' };
  }
}

/** @param value - 标识值 @param label - 用户提示标签 @param key - payload 字段 @returns 有界 payload 或稳定错误 @author lvdaxianer@yeah.net @date 2026-10-17 */
function requiredPayload(value: string | undefined, label: string, key: string): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  // 缺少目标标识时保持参数错误，不调用 Service。
  return value ? { ok: true, value: { [key]: value } } : { ok: false, message: `CLI 缺少 ${label} 参数\n` };
}

/** @param operation - Service 操作 @param context - 显式授权上下文 @param payload - 有界 payload @returns Service 请求 @author lvdaxianer@yeah.net @date 2026-10-17 */
function buildRequest(operation: ServiceApiRequest['operation'], context: { tenantId: string; actorId: string }, payload: Record<string, unknown>): { ok: true; request: ServiceApiRequest } {
  const requestId = `cli-${operation}-${context.tenantId}`;
  return { ok: true, request: { protocolVersion: 'iar.service-api/v1', requestId, traceId: requestId, context, operation, payload } };
}

const COMMAND_OPERATIONS: Record<Exclude<CliCommand, 'inspect'>, ServiceApiRequest['operation']> = { install: 'plugin.install', enable: 'plugin.enable', disable: 'plugin.disable', replay: 'run.replay' };

/** @param command - 公开命令 @param values - 已解析 flags @returns 固定 Service 操作 @author lvdaxianer@yeah.net @date 2026-10-17 */
function operationFor(command: CliCommand, values: Map<string, string>): ServiceApiRequest['operation'] {
  return command === 'inspect' ? (values.has('run') ? 'run.get' : 'plugin.inspect') : COMMAND_OPERATIONS[command];
}

/**
 * CLI 只接受五个公开命令。
 *
 * @param value - argv 第一个命令字段
 * @returns 是否为公开 CLI command
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isCommand(value: unknown): value is CliCommand {
  return value === 'install' || value === 'enable' || value === 'disable' || value === 'inspect' || value === 'replay';
}

export type { ServiceApiResponse as CliResponse };
