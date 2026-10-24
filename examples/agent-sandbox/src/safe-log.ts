/**
 * 输出不包含请求或异常内容的安全结构化日志。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ModelAuditEntry } from '@iar/runtime';
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
const CONTRACT_MESSAGES: Readonly<Record<string, { zh: string; en: string }>> = {
  operation_missing: { zh: '缺少操作标识', en: 'Operation identifier is missing' },
  operation_conflict: { zh: '操作信息冲突', en: 'Operation information conflicts' },
  operation_not_allowed: { zh: '操作不在 Function 契约内', en: 'Operation is not allowed by the Function contract' },
  function_arguments_invalid: { zh: 'Function 参数不符合输入契约', en: 'Function arguments violate the input contract' }
};
const SAFE_CONTRACT_IDENTIFIERS = /^[A-Za-z0-9_.|:-]{1,256}$/;
/** 日志中允许出现的枚举字符串。 */
const SAFE_VALUES: Readonly<Record<string, readonly string[]>> = {
  level: ['trace', 'info', 'warn', 'error', 'debug'], event: ['http.request.start', 'http.request.end', 'http.stream', 'model.http', 'iar.model.audit', 'iar.parameter.boundary', 'iar.turn.stage', 'iar.turn.completed', 'iar.route.contract', 'iar.semantic.frame', 'iar.route.decision', 'iar.bridge.error', 'model.reasoning', 'sandbox.pi_agent', 'sandbox.start', 'sandbox.start_failed', 'sandbox.shutdown_failed', 'sandbox.snapshot'],
  outcome: ['network_error', 'http_error', 'invalid_response', 'timeout', 'aborted', 'slow', 'success', 'stream_failed', 'stream_write_failed', 'bridge_error', 'agent_unavailable', 'model_fallback', 'startup_failed', 'port_in_use', 'shutdown_failed', 'invalid_mode', 'missing_api_key', 'snapshot_failed', 'contract_violation'],
  reasonCode: [...Object.keys(CONTRACT_MESSAGES), 'semantic_incomplete', 'route_not_proposed', 'candidate_empty', 'route_matched', 'confirmation_required', 'action_failed', 'route_contract_invalid', 'function_arguments_invalid', 'parameters_required', 'parameter_missing', 'parameter_invalid', 'parameter_collected', 'bridge_timeout', 'bridge_unavailable', 'bridge_request_invalid', 'bridge_session_failed', 'bridge_internal_error', 'model.invalid_request', 'model.no_profile', 'model.no_provider', 'model.timeout', 'model.provider_failed', 'model.schema_invalid', 'model.threshold_rejected', 'model.fallback_failed'],
  target: ['model.chat.completions', 'model.jev.systemone'], method: ['GET', 'POST', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE', 'OTHER'],
  path: ['/', '/api/chat', '/api/confirm', '/api/compact', '/api/state', '/api/reset', 'unknown',
    '/api/sessions', '/api/sessions/:sessionId', '/api/sessions/:sessionId/chat', '/api/sessions/:sessionId/confirm',
    '/api/sessions/:sessionId/compact', '/api/sessions/:sessionId/state', '/api/sessions/:sessionId/reset', '/api/sessions/:sessionId/resume',
    '/api/pi-host/session/:sessionId',
    '/api/bridge/v1/sessions', '/api/bridge/v1/sessions/:sessionId/input', '/api/bridge/v1/sessions/:sessionId/input/stream', '/api/bridge/v1/sessions/:sessionId/confirm', '/api/bridge/v1/sessions/:sessionId/state'],
  stage: ['semantic.extract', 'route.propose', 'route.select', 'action.execute', 'response.reasoning', 'response.generate'], nextStage: ['route.propose', 'route.select', 'action.execute', 'response.generate'],
  missingField: ['intent', 'action', 'pluginId', 'functionId', 'operation', 'parameters'], fieldState: ['expected', 'present', 'missing', 'invalid'], semanticAction: ['query', 'create', 'update', 'delete', 'transfer', 'execute', 'unknown'], execution: ['allowed', 'blocked', 'skipped'],
  status: ['completed', 'failed', 'skipped'],
  modelRole: ['semantic.extract', 'route.propose', 'function.call', 'function.select', 'plugin.select', 'context.compact', 'response.generate'],
  host: ['127.0.0.1'], mode: ['brain', 'scripted'], selection: ['explicit', 'configured', 'fallback']
};
/** 允许输出的数字字段。 */
const SAFE_NUMBERS = new Set(['startTime', 'endTime', 'durationMs', 'firstTokenMs', 'status', 'candidateCount', 'allowedValueCount', 'attempt', 'expectedFieldCount', 'actualFieldCount', 'missingFieldCount', 'invalidFieldCount']);
/** 只允许输出有限的布尔诊断字段。 */
const SAFE_BOOLEAN_KEYS = new Set(['hasIntent', 'hasAction', 'hasPluginId', 'hasFunctionId', 'hasOperation', 'fallbackUsed']);
/** 语义模型输出中的稳定标识符仅允许受控字符，不输出自然语言正文。 */
const SAFE_IDENTIFIER_KEYS = new Set(['semanticIntent', 'semanticPluginId', 'semanticFunctionId', 'pluginId', 'functionId', 'profileId', 'modelId', 'modelVersion', 'fieldName']);
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
  if (key === 'status') return (typeof value === 'number' && Number.isInteger(value) && value >= MIN_HTTP_STATUS && value <= MAX_HTTP_STATUS) || (typeof value === 'string' && (SAFE_VALUES.status?.includes(value) ?? false));
  // 监听端口只能是有效 TCP 端口，不能用数字携带任意数据。
  if (key === 'port') return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
  // 时间和耗时只接受非负安全整数。
  if (SAFE_NUMBERS.has(key)) return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (SAFE_BOOLEAN_KEYS.has(key)) return typeof value === 'boolean' || (typeof value === 'string' && (value === 'true' || value === 'false'));
  // 链路标识只接受固定 UUID 格式。
  if (SAFE_IDS.has(key)) return typeof value === 'string' && UUID_PATTERN.test(value);
  if (SAFE_IDENTIFIER_KEYS.has(key)) return typeof value === 'string' && SAFE_CONTRACT_IDENTIFIERS.test(value);
  if (key === 'expectedOperation' || key === 'actualOperation') return typeof value === 'string' && SAFE_CONTRACT_IDENTIFIERS.test(value);
  if (key === 'messageZh') return typeof value === 'string' && Object.values(CONTRACT_MESSAGES).some((message) => message.zh === value);
  if (key === 'messageEn') return typeof value === 'string' && Object.values(CONTRACT_MESSAGES).some((message) => message.en === value);
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

/**
 * 创建中文与英文并列的可读日志写入器。
 *
 * 输入必须已经经过安全接收器的白名单序列化；解析失败时原样转发，避免日志适配器影响业务。
 * @param writer - 最终字节写入器
 * @returns 双语格式写入器
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
export function createBilingualLogWriter(writer: SafeLogWriter): SafeLogWriter {
  return (buffer, done) => {
    try {
      const record = JSON.parse(buffer.toString('utf8')) as Record<string, unknown>;
      const formatted = Buffer.from(`${formatBilingualLogLine(record)}\n`);
      let offset = 0;
      const writePart = (): void => writer(formatted.subarray(offset), (error, written) => {
        if (error || !Number.isInteger(written) || written <= 0 || written > formatted.length - offset) {
          done(error ?? new Error('bilingual log writer stalled'), 0);
          return;
        }
        offset += written;
        if (offset < formatted.length) writePart();
        else done(null, buffer.length);
      });
      writePart();
    } catch {
      writer(buffer, done);
    }
  };
}

/** 日志格式只允许机器 JSON 或终端可读摘要。 */
type LogFormat = 'json' | 'pretty';

/**
 * 解析当前进程的日志格式配置。
 *
 * 未配置或配置为未知值时使用终端可读摘要；需要机器解析时显式设置 json。
 * @returns 规范化后的日志格式
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
function resolveLogFormat(): LogFormat {
  return process.env.IAR_LOG_FORMAT?.trim().toLowerCase() === 'json' ? 'json' : 'pretty';
}

/**
 * 按环境配置创建默认日志写入器。
 * @param format - 目标日志格式
 * @returns 默认安全日志写入器
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
function createEnvironmentWriter(format: LogFormat): SafeLogWriter {
  return format === 'pretty' ? createBilingualLogWriter(defaultLogWriter) : defaultLogWriter;
}
let environmentFormat = resolveLogFormat();
let sinkMode: 'environment' | 'custom' = 'environment';
let sink = createSafeLogSink(createEnvironmentWriter(environmentFormat), MAX_LOG_QUEUE);

/**
 * 在首次写入前同步环境文件加载后的日志格式变化。
 *
 * 自定义宿主写入器和已有排队记录不参与切换，避免并发输出到两个接收器。
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
function refreshEnvironmentWriter(): void {
  if (sinkMode !== 'environment' || !sink.isIdle()) return;
  const format = resolveLogFormat();
  if (format === environmentFormat) return;
  sink = createSafeLogSink(createEnvironmentWriter(format), MAX_LOG_QUEUE);
  environmentFormat = format;
}

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
  sinkMode = 'custom';
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
  const previousMode = sinkMode;
  const replacement = createSafeLogSink(writer, MAX_LOG_QUEUE);
  sinkMode = 'custom';
  sink = replacement;
  // 仅当测试接收器仍是当前接收器时才恢复，避免覆盖其他替换。
  return () => { if (sink === replacement) { sink = previous; sinkMode = previousMode; } };
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
  refreshEnvironmentWriter();
  sink.write(record);
}

/**
 * 将安全白名单中的结构化日志转换为双语单行摘要。
 *
 * 该函数只消费已允许的字段，未知字段和自由文本不会进入结果，方便终端直接阅读。
 * @param record - 待格式化的结构化日志
 * @returns 双语日志行
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
export function formatBilingualLogLine(record: Record<string, unknown>): string {
  const safe = Object.fromEntries(Object.entries(record).filter(isSafeEntry));
  const event = typeof safe.event === 'string' ? safe.event : 'iar.observability';
  const label = event === 'iar.turn.stage' ? '阶段耗时 / Stage timing' : event === 'iar.turn.completed' ? '轮次完成 / Turn completed' : event === 'iar.route.contract' ? '路由契约失败 / Route contract failure' : event === 'iar.semantic.frame' ? '语义抽取 / Semantic extraction' : event === 'iar.route.decision' ? '路由决策 / Route decision' : event === 'iar.model.audit' ? '模型调用审计 / Model attempt' : event === 'iar.parameter.boundary' ? '参数边界 / Parameter boundary' : event === 'iar.bridge.error' ? '桥接错误 / Bridge error' : event === 'sandbox.pi_agent' ? 'Pi 委托 / Pi Agent' : event === 'model.reasoning' ? '模型思考 / Model reasoning' : '运行事件 / Runtime event';
  const stage = typeof safe.stage === 'string' ? ` stage=${safe.stage}` : '';
  const modelRole = typeof safe.modelRole === 'string' ? ` modelRole=${safe.modelRole}` : '';
  const outcome = typeof safe.outcome === 'string' ? ` outcome=${safe.outcome}` : '';
  const status = typeof safe.status === 'string' ? ` status=${safe.status}` : '';
  const duration = typeof safe.durationMs === 'number' ? ` duration=${safe.durationMs}ms` : '';
  const firstToken = typeof safe.firstTokenMs === 'number' ? ` firstToken=${safe.firstTokenMs}ms` : '';
  const level = typeof safe.level === 'string' ? safe.level.toUpperCase() : 'INFO';
  const trace = typeof safe.traceId === 'string' ? ` traceId=${safe.traceId}` : '';
  const reasonCode = typeof safe.reasonCode === 'string' ? ` reasonCode=${safe.reasonCode}` : '';
  const expectedOperation = typeof safe.expectedOperation === 'string' ? ` expectedOperation=${safe.expectedOperation}` : '';
  const actualOperation = typeof safe.actualOperation === 'string' ? ` actualOperation=${safe.actualOperation}` : '';
  const profileId = typeof safe.profileId === 'string' ? ` profileId=${safe.profileId}` : '';
  const modelId = typeof safe.modelId === 'string' ? ` modelId=${safe.modelId}` : '';
  const modelVersion = typeof safe.modelVersion === 'string' ? ` modelVersion=${safe.modelVersion}` : '';
  const attempt = typeof safe.attempt === 'number' ? ` attempt=${safe.attempt}` : '';
  const fallbackUsed = safe.fallbackUsed !== undefined ? ` fallbackUsed=${String(safe.fallbackUsed)}` : '';
  const fieldName = typeof safe.fieldName === 'string' ? ` fieldName=${safe.fieldName}` : '';
  const fieldState = typeof safe.fieldState === 'string' ? ` fieldState=${safe.fieldState}` : '';
  const expectedFieldCount = typeof safe.expectedFieldCount === 'number' ? ` expectedFieldCount=${safe.expectedFieldCount}` : '';
  const actualFieldCount = typeof safe.actualFieldCount === 'number' ? ` actualFieldCount=${safe.actualFieldCount}` : '';
  const missingFieldCount = typeof safe.missingFieldCount === 'number' ? ` missingFieldCount=${safe.missingFieldCount}` : '';
  const invalidFieldCount = typeof safe.invalidFieldCount === 'number' ? ` invalidFieldCount=${safe.invalidFieldCount}` : '';
  const semanticIntent = typeof safe.semanticIntent === 'string' ? ` semanticIntent=${safe.semanticIntent}` : '';
  const semanticAction = typeof safe.semanticAction === 'string' ? ` semanticAction=${safe.semanticAction}` : '';
  const missingField = typeof safe.missingField === 'string' ? ` missingField=${safe.missingField}` : '';
  const nextStage = typeof safe.nextStage === 'string' ? ` nextStage=${safe.nextStage}` : '';
  const candidateCount = typeof safe.candidateCount === 'number' ? ` candidateCount=${safe.candidateCount}` : '';
  const allowedValueCount = typeof safe.allowedValueCount === 'number' ? ` allowedValueCount=${safe.allowedValueCount}` : '';
  const execution = typeof safe.execution === 'string' ? ` execution=${safe.execution}` : '';
  const hasFields = ['hasIntent', 'hasAction', 'hasPluginId', 'hasFunctionId', 'hasOperation'].filter((key) => safe[key] !== undefined).map((key) => `${key}=${String(safe[key])}`).join(' ');
  const messageZh = typeof safe.messageZh === 'string' ? ` messageZh=${safe.messageZh}` : '';
  const messageEn = typeof safe.messageEn === 'string' ? ` messageEn=${safe.messageEn}` : '';
  return `${level} ${label}${stage}${modelRole}${profileId}${modelId}${modelVersion}${attempt}${fallbackUsed}${status}${outcome}${reasonCode}${semanticIntent}${semanticAction}${hasFields.length === 0 ? '' : ` ${hasFields}`}${missingField}${fieldName}${fieldState}${expectedFieldCount}${actualFieldCount}${missingFieldCount}${invalidFieldCount}${nextStage}${candidateCount}${allowedValueCount}${execution}${expectedOperation}${actualOperation}${duration}${firstToken}${trace}${messageZh}${messageEn}`;
}

/** 语义抽取阶段的安全诊断字段。 */
export type SemanticFrameDiagnostic = {
  status: 'completed' | 'failed';
  semanticIntent?: string;
  semanticAction?: string;
  hasIntent: boolean;
  hasAction: boolean;
  missingField?: 'intent' | 'action' | 'pluginId' | 'functionId' | 'operation' | 'parameters';
  nextStage?: 'route.propose' | 'route.select' | 'action.execute' | 'response.generate';
  durationMs?: number;
};

/** 路由门禁阶段的安全诊断字段。 */
export type RouteDecisionDiagnostic = {
  stage: 'route.propose' | 'route.select' | 'action.execute';
  status: 'completed' | 'failed' | 'skipped';
  reasonCode: string;
  candidateCount?: number;
  allowedValueCount?: number;
  execution?: 'allowed' | 'blocked' | 'skipped';
  pluginId?: string;
  functionId?: string;
  durationMs?: number;
};

/** 模型单次 attempt 的安全审计字段，不记录输入、输出或思考内容。 */
export type ModelAuditDiagnostic = Pick<ModelAuditEntry, 'traceId' | 'runId' | 'role' | 'profileId' | 'profileVersion' | 'modelId' | 'modelVersion' | 'attempt' | 'outcome' | 'fallbackUsed' | 'metadata'> & { errorCode?: string };

/** Function 输入边界的字段状态，只记录 Schema 字段名和计数。 */
export type ParameterBoundaryDiagnostic = {
  stage: 'action.execute';
  status: 'completed' | 'failed' | 'skipped';
  reasonCode: string;
  pluginId?: string;
  functionId?: string;
  fieldName?: string;
  fieldState: 'expected' | 'present' | 'missing' | 'invalid';
  expectedFieldCount?: number;
  actualFieldCount?: number;
  missingFieldCount?: number;
  invalidFieldCount?: number;
};

/**
 * 记录语义抽取的字段状态，不记录用户原文和模型原始响应。
 * @param traceId - 当前轮次链路标识
 * @param diagnostic - 受控语义帧摘要
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-23
 */
export function logSemanticFrame(traceId: string, diagnostic: SemanticFrameDiagnostic): void {
  const context = contexts.getStore();
  writeSafeLog({
    level: diagnostic.status === 'failed' ? 'warn' : 'info', event: 'iar.semantic.frame', traceId: context?.origin === 'http' ? context.traceId : safeModelTraceId(traceId),
    ...diagnostic
  });
}

/**
 * 记录路由门禁和执行阻断原因，不记录模型提案原文。
 * @param traceId - 当前轮次链路标识
 * @param diagnostic - 受控路由摘要
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-23
 */
export function logRouteDecision(traceId: string, diagnostic: RouteDecisionDiagnostic): void {
  const context = contexts.getStore();
  writeSafeLog({
    level: diagnostic.status === 'failed' || diagnostic.execution === 'blocked' ? 'warn' : 'info', event: 'iar.route.decision', traceId: context?.origin === 'http' ? context.traceId : safeModelTraceId(traceId),
    ...diagnostic
  });
}

/** 记录模型每次 attempt 的 profile、模型和稳定失败码，不记录原始模型内容。 */
export function logModelAudit(audit: ModelAuditDiagnostic, errorCode?: string): void {
  const context = contexts.getStore();
  const traceId = context?.origin === 'http' ? context.traceId : safeModelTraceId(audit.traceId);
  writeSafeLog({
    level: audit.outcome === 'success' || audit.outcome === 'fallback' ? 'info' : 'warn', event: 'iar.model.audit', traceId,
    modelRole: audit.role, profileId: audit.profileId, modelId: audit.modelId, modelVersion: audit.modelVersion,
    attempt: audit.attempt, outcome: audit.outcome, fallbackUsed: audit.fallbackUsed,
    ...(errorCode === undefined ? {} : { reasonCode: errorCode })
  });
}

/** 记录 Schema 期望字段、实际字段和缺失/非法计数，不记录字段值。 */
export function logParameterBoundary(traceId: string, diagnostic: ParameterBoundaryDiagnostic): void {
  const context = contexts.getStore();
  writeSafeLog({
    level: diagnostic.status === 'failed' || diagnostic.fieldState === 'missing' || diagnostic.fieldState === 'invalid' ? 'warn' : 'info',
    event: 'iar.parameter.boundary', traceId: context?.origin === 'http' ? context.traceId : safeModelTraceId(traceId), ...diagnostic
  });
}

/** 路由契约失败的安全诊断输入；只接受固定原因码和有限标识。 */
export type RouteContractFailure = {
  reasonCode: string;
  expectedOperation?: string;
  actualOperation?: string;
};

/** 记录路由契约失败，不记录模型原文、请求正文或异常文本。 */
export function logRouteContractFailure(traceId: string, diagnostic: RouteContractFailure): void {
  const message = CONTRACT_MESSAGES[diagnostic.reasonCode];
  if (!message) return;
  const context = contexts.getStore();
  const contextTraceId = context?.origin === 'http' ? context.traceId : undefined;
  writeSafeLog({
    level: 'warn', event: 'iar.route.contract', outcome: 'contract_violation', traceId: contextTraceId ?? safeModelTraceId(traceId),
    reasonCode: diagnostic.reasonCode,
    ...(diagnostic.expectedOperation === undefined ? {} : { expectedOperation: diagnostic.expectedOperation.slice(0, 256) }),
    ...(diagnostic.actualOperation === undefined ? {} : { actualOperation: diagnostic.actualOperation.slice(0, 256) }),
    messageZh: message.zh, messageEn: message.en
  });
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
 * 记录桥接层稳定错误分类，避免客户端只看到无 trace 的通用失败。
 * @param reasonCode - 已归并的桥接错误原因码
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-23
 */
export function logBridgeFailure(reasonCode: 'bridge_timeout' | 'bridge_unavailable' | 'bridge_request_invalid' | 'bridge_session_failed' | 'bridge_internal_error'): void {
  writeSafeLog({ level: 'error', event: 'iar.bridge.error', outcome: 'bridge_error', reasonCode, traceId: resolveSandboxTraceId(randomUUID()) });
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
 * @param modelRole - 当前模型调用角色
 * @param target - 当前模型上游协议目标
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function logModelSuccess(startTime: number, status: number, modelRole?: string, target: 'model.chat.completions' | 'model.jev.systemone' = 'model.chat.completions'): void {
  const endTime = Date.now();
  const isSlow = endTime - startTime >= MODEL_SLOW_MS;
  // 未开启调试且调用不慢时无需输出。
  if (!isDebugEnabled && !isSlow) return;
  const context = contexts.getStore() ?? { traceId: randomUUID() };
  writeSafeLog({ level: isSlow ? 'warn' : 'debug', event: 'model.http', outcome: isSlow ? 'slow' : 'success', ...(modelRole === undefined ? {} : { modelRole }), ...context,
    target, startTime, endTime, durationMs: endTime - startTime, status });
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
 * @param modelRole - 当前模型调用角色
 * @param target - 当前模型上游协议目标
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function logModelNetworkFailure(startTime: number, signal: AbortSignal, modelRole?: string, target: 'model.chat.completions' | 'model.jev.systemone' = 'model.chat.completions'): void {
  const isTimeout = signal.aborted && signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError';
  const outcome = isTimeout ? 'timeout' : signal.aborted ? 'aborted' : 'network_error';
  writeModelFailure(startTime, outcome, undefined, modelRole, target);
}

/**
 * 记录模型 HTTP 非成功状态。
 *
 * @param startTime - 请求开始时间
 * @param status - HTTP 状态码
 * @param modelRole - 当前模型调用角色
 * @param target - 当前模型上游协议目标
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function logModelHttpFailure(startTime: number, status: number, modelRole?: string, target: 'model.chat.completions' | 'model.jev.systemone' = 'model.chat.completions'): void {
  writeModelFailure(startTime, 'http_error', status, modelRole, target);
}

/**
 * 记录模型响应格式或内容不可用。
 *
 * @param startTime - 请求开始时间
 * @param status - HTTP 状态码
 * @param modelRole - 当前模型调用角色
 * @param target - 当前模型上游协议目标
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function logModelInvalidResponse(startTime: number, status: number, modelRole?: string, target: 'model.chat.completions' | 'model.jev.systemone' = 'model.chat.completions'): void {
  writeModelFailure(startTime, 'invalid_response', status, modelRole, target);
}

/**
 * 统一记录模型失败的固定字段，不接收异常或自由文本。
 * @param startTime - 模型调用开始时间
 * @param outcome - 安全失败分类
 * @param status - 可选的 HTTP 状态码
 * @param modelRole - 当前模型调用角色
 * @param target - 当前模型上游协议目标
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function writeModelFailure(startTime: number, outcome: 'timeout' | 'aborted' | 'network_error' | 'http_error' | 'invalid_response', status?: number, modelRole?: string, target: 'model.chat.completions' | 'model.jev.systemone' = 'model.chat.completions'): void {
  const endTime = Date.now();
  const context = contexts.getStore() ?? { traceId: randomUUID() };
  writeSafeLog({ level: 'warn', event: 'model.http', outcome, ...(modelRole === undefined ? {} : { modelRole }), ...context, target,
    startTime, endTime, durationMs: endTime - startTime, status });
}
