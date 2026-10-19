/**
 * 输出不包含请求或异常内容的安全结构化日志。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { defaultLogWriter, SafeLogSink, type SafeLogSinkStatus, type SafeLogWriter } from './safe-log-sink.js';

/** 每个请求独立的链路标识。 */
type LogContext = { requestId?: string; traceId: string; origin?: 'http' | 'model' };
/** 异步调用链的上下文存储。 */
const contexts = new AsyncLocalStorage<LogContext>();
/** 进程私有映射密钥，避免直接输入可被离线枚举。 */
const traceMappingKey = randomBytes(32);
/** 调试开关仅接受操作系统授权的进程信号。 */
let isDebugEnabled = false;
/** 当前使用信号控制的服务数量。 */
let signalUsers = 0;
/** 模型调用慢日志阈值，单位毫秒。 */
const MODEL_SLOW_MS = 500;
/** 安全日志最多等待的记录数与单条写入期限。 */
const MAX_LOG_QUEUE = 128;
const MAX_LOG_WRITE_MS = 1000;
/** 日志中允许出现的枚举字符串。 */
const SAFE_VALUES: Readonly<Record<string, readonly string[]>> = {
  level: ['info', 'warn', 'debug'], event: ['http.request.start', 'http.request.end', 'http.stream', 'model.http', 'sandbox.start', 'sandbox.start_failed', 'sandbox.shutdown_failed'],
  outcome: ['network_error', 'http_error', 'invalid_response', 'timeout', 'aborted', 'slow', 'success', 'stream_failed', 'stream_write_failed', 'startup_failed', 'shutdown_failed', 'invalid_mode', 'missing_api_key'],
  target: ['model.chat.completions'], method: ['GET', 'POST', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE', 'OTHER'],
  path: ['/', '/api/chat', '/api/confirm', '/api/compact', '/api/state', '/api/reset', 'unknown',
    '/api/sessions', '/api/sessions/:sessionId', '/api/sessions/:sessionId/chat', '/api/sessions/:sessionId/confirm',
    '/api/sessions/:sessionId/compact', '/api/sessions/:sessionId/state', '/api/sessions/:sessionId/reset'],
  host: ['127.0.0.1'], mode: ['brain', 'scripted'], selection: ['explicit', 'configured', 'fallback']
};
/** 允许输出的数字字段。 */
const SAFE_NUMBERS = new Set(['startTime', 'endTime', 'durationMs', 'status']);
/** HTTP 状态码的合法范围。 */
const MIN_HTTP_STATUS = 100;
const MAX_HTTP_STATUS = 599;
/** 允许输出的由服务生成的链路标识。 */
const SAFE_IDS = new Set(['traceId', 'requestId']);
/** 标识格式禁止携带自由文本。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 将所有外部链路映射为进程内稳定的固定格式摘要。
 * @param traceId - 业务模型请求的链路标识
 * @returns 可安全记录的链路标识
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function safeModelTraceId(traceId: string): string {
  // UUID 外形同样可能是秘密，所有直接输入均使用带密钥摘要。
  const digest = createHmac('sha256', traceMappingKey).update(traceId).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

/**
 * 优先继承 HTTP 链路，否则隔离直接调用的安全映射链路。
 * @param traceId - 业务请求的链路标识
 * @param next - 模型调用
 * @returns 模型调用结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function runWithModelLogContext<T>(traceId: string, next: () => T): T {
  return contexts.getStore()?.origin === 'http' ? next()
    : contexts.run({ traceId: safeModelTraceId(traceId), origin: 'model' }, next);
}

/**
 * 判断日志字段和值是否属于固定白名单。
 *
 * @param entry - 待检查字段和值
 * @returns 是否可安全输出
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function isSafeEntry([key, value]: [string, unknown]): boolean {
  // 数字、标识和有限枚举分别验证，其他内容全部丢弃。
  if (key === 'status') return typeof value === 'number' && Number.isInteger(value) && value >= MIN_HTTP_STATUS && value <= MAX_HTTP_STATUS;
  // 监听端口只能是有效 TCP 端口，不能用数字携带任意数据。
  if (key === 'port') return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
  // 时间和耗时只接受非负安全整数。
  if (SAFE_NUMBERS.has(key)) return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  // 链路标识只接受固定 UUID 格式。
  if (SAFE_IDS.has(key)) return typeof value === 'string' && UUID_PATTERN.test(value);
  return typeof value === 'string' && (SAFE_VALUES[key]?.includes(value) ?? false);
}

/**
 * 创建始终使用安全字段白名单的有界接收器。
 * @param writer - 异步字节写入适配器
 * @param capacity - 最大等待记录数
 * @param timeoutMs - 单条记录写入期限，最大一秒
 * @returns 有界安全接收器
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function createSafeLogSink(writer: SafeLogWriter, capacity: number, timeoutMs = MAX_LOG_WRITE_MS): SafeLogSink {
  const boundedCapacity = Math.max(1, Math.min(MAX_LOG_QUEUE, Math.floor(capacity) || 1));
  const boundedTimeout = Math.max(1, Math.min(MAX_LOG_WRITE_MS, Math.floor(timeoutMs) || 1));
  return new SafeLogSink({ writer, capacity: boundedCapacity, timeoutMs: boundedTimeout,
    serialize: (record) => JSON.stringify(Object.fromEntries(Object.entries(record).filter(isSafeEntry))) });
}

/** 当前进程的默认安全接收器。 */
let sink = createSafeLogSink(defaultLogWriter, MAX_LOG_QUEUE);

/**
 * 在空闲时安装宿主专用异步写入边界，不关闭宿主资源。
 * @param writer - 专用异步字节写入适配器
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function configureSafeLogWriter(writer: SafeLogWriter): void {
  // 在途写入或排队期间禁止切换，避免两个接收器并发输出。
  if (!sink.isIdle()) throw new Error('safe log sink is not idle');
  sink = createSafeLogSink(writer, MAX_LOG_QUEUE);
}

/**
 * 获取进程级安全接收器的不可变状态快照。
 * @returns 有界计数与当前队列状态
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function getSafeLogSinkStatus(): Readonly<SafeLogSinkStatus> { return sink.getStatus(); }

/**
 * 仅供进程内测试替换安全接收器，不改变白名单。
 * @param writer - 测试使用的异步写入适配器
 * @returns 恢复先前接收器的函数
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function setSafeLogWriterForTesting(writer: SafeLogWriter): () => void {
  const previous = sink;
  const replacement = createSafeLogSink(writer, MAX_LOG_QUEUE);
  sink = replacement;
  // 仅当测试接收器仍是当前接收器时才恢复，避免覆盖其他替换。
  return () => { if (sink === replacement) sink = previous; };
}

/**
 * 只供测试检查日志已排空，不改变生产调用时机。
 * @returns 当前接收器是否空闲
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function safeLogIsIdleForTesting(): boolean { return sink.isIdle(); }

/**
 * 写入日志，输出故障不得影响沙箱业务。
 *
 * @param record - 已限定字段的审计记录
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function writeSafeLog(record: Record<string, unknown>): void {
  sink.write(record);
}

/**
 * 记录 SSE 已发送响应头后的会话失败，不暴露异常内容。
 *
 * @param outcome - 固定会话失败或 SSE 写入失败分类
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function logStreamFailure(outcome: 'stream_failed' | 'stream_write_failed' = 'stream_failed'): void {
  const context = contexts.getStore() ?? { traceId: randomUUID() };
  writeSafeLog({ level: 'warn', event: 'http.stream', outcome, ...context });
}

/**
 * 在 HTTP 调用中复用入口链路，独立会话调用保留原有标识。
 *
 * @param fallback - 独立会话原有的链路标识
 * @returns 当前入口链路或原有标识
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function resolveSandboxTraceId(fallback: string): string {
  const context = contexts.getStore();
  return context?.origin === 'http' ? context.traceId : fallback;
}

/**
 * 切换模型调用的诊断级别。
 *
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function toggleModelDebug(): void {
  isDebugEnabled = !isDebugEnabled;
}

/**
 * 启用基于进程权限的调试开关并返回释放函数。
 *
 * @returns 释放该服务对信号的引用
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function registerDebugSignal(): () => void {
  // 首个服务注册处理器，其余服务共享同一进程级开关。
  if (signalUsers === 0) process.on('SIGHUP', toggleModelDebug);
  signalUsers += 1;
  let isReleased = false;
  return () => {
    // 同一服务可重复关闭，但只能释放一次共享引用。
    if (isReleased) return;
    isReleased = true;
    signalUsers -= 1;
    // 最后一个服务关闭后恢复默认关闭状态。
    if (signalUsers === 0) {
      process.off('SIGHUP', toggleModelDebug);
      isDebugEnabled = false;
    }
  };
}

/**
 * 按当前调试级别输出成功调用的安全元数据。
 *
 * @param startTime - 请求开始时间
 * @param status - HTTP 状态码
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function logModelSuccess(startTime: number, status: number): void {
  const endTime = Date.now();
  const isSlow = endTime - startTime >= MODEL_SLOW_MS;
  // 未开启调试且调用不慢时无需输出。
  if (!isDebugEnabled && !isSlow) return;
  const context = contexts.getStore() ?? { traceId: randomUUID() };
  writeSafeLog({ level: isSlow ? 'warn' : 'debug', event: 'model.http', outcome: isSlow ? 'slow' : 'success', ...context,
    target: 'model.chat.completions', startTime, endTime, durationMs: endTime - startTime, status });
}

/**
 * 在指定请求上下文内继续执行异步调用链。
 *
 * @param context - 由服务生成的链路标识
 * @param next - 后续处理入口
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function runWithLogContext(context: LogContext, next: () => void): void {
  contexts.run({ ...context, origin: 'http' }, next);
}

/**
 * 记录模型 HTTP 网络失败的安全摘要。
 *
 * @param startTime - 请求开始时间
 * @param signal - 调用取消信号
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function logModelNetworkFailure(startTime: number, signal: AbortSignal): void {
  const isTimeout = signal.aborted && signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError';
  const outcome = isTimeout ? 'timeout' : signal.aborted ? 'aborted' : 'network_error';
  writeModelFailure(startTime, outcome);
}

/**
 * 记录模型 HTTP 非成功状态。
 *
 * @param startTime - 请求开始时间
 * @param status - HTTP 状态码
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function logModelHttpFailure(startTime: number, status: number): void {
  writeModelFailure(startTime, 'http_error', status);
}

/**
 * 记录模型响应格式或内容不可用。
 *
 * @param startTime - 请求开始时间
 * @param status - HTTP 状态码
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function logModelInvalidResponse(startTime: number, status: number): void {
  writeModelFailure(startTime, 'invalid_response', status);
}

/**
 * 统一记录模型失败的固定字段，不接收异常或自由文本。
 * @param startTime - 模型调用开始时间
 * @param outcome - 安全失败分类
 * @param status - 可选的 HTTP 状态码
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function writeModelFailure(startTime: number, outcome: 'timeout' | 'aborted' | 'network_error' | 'http_error' | 'invalid_response', status?: number): void {
  const endTime = Date.now();
  const context = contexts.getStore() ?? { traceId: randomUUID() };
  writeSafeLog({ level: 'warn', event: 'model.http', outcome, ...context, target: 'model.chat.completions',
    startTime, endTime, durationMs: endTime - startTime, status });
}
