/**
 * 提供统一的结构化观测记录器和 fail-open sink 边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { redactFields } from './redaction.js';
import { OBSERVABILITY_SCHEMA_VERSION, type LogInput, type MetricInput, type ObservabilityInput, type ObservabilityKind, type ObservabilityOptions, type ObservabilityRecord, type ObserverSink } from './types.js';

const DEFAULT_MAX_METADATA_BYTES = 65_536;

/** 在所有观测类型之间复用关联字段、脱敏和 sink 失败策略。 */
export class ObservabilityRecorder {
  private readonly records: ObservabilityRecord[] = [];
  private readonly sink: ObserverSink | undefined;
  private readonly clock: () => string;
  private readonly sensitivePaths: readonly string[];
  private readonly maxMetadataBytes: number;
  private failures = 0;

  /** @param options - sink、时钟和脱敏配置 @returns 新 recorder @author lvdaxianer@yeah.net @date 2026-10-17 */
  public constructor(options: ObservabilityOptions = {}) {
    this.sink = options.sink;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.sensitivePaths = [...(options.sensitivePaths ?? [])];
    this.maxMetadataBytes = options.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES;
    if (!Number.isSafeInteger(this.maxMetadataBytes) || this.maxMetadataBytes <= 0) throw new TypeError('观测 metadata 上限无效');
  }

  /** @param input - 结构化日志输入 @returns 已脱敏记录 @author lvdaxianer@yeah.net @date 2026-10-17 */
  public log(input: LogInput): Promise<ObservabilityRecord> { return this.write('log', input, { level: isLogLevel(input.level) ? input.level : 'error' }); }

  /** @param input - trace 输入 @returns 已脱敏记录 @author lvdaxianer@yeah.net @date 2026-10-17 */
  public trace(input: ObservabilityInput): Promise<ObservabilityRecord> { return this.write('trace', input); }

  /** @param input - metric 输入 @returns 已脱敏记录 @author lvdaxianer@yeah.net @date 2026-10-17 */
  public metric(input: MetricInput): Promise<ObservabilityRecord> { return this.write('metric', input, { name: stableMetricName(input.name), value: Number.isFinite(input.value) ? input.value : 0 }); }

  /** @param input - audit 输入 @returns 已脱敏记录 @author lvdaxianer@yeah.net @date 2026-10-17 */
  public audit(input: ObservabilityInput): Promise<ObservabilityRecord> { return this.write('audit', input); }

  /** @returns 脱敏快照 @author lvdaxianer@yeah.net @date 2026-10-17 */
  public snapshot(): readonly ObservabilityRecord[] { return structuredClone(this.records); }

  /** @returns sink 失败次数 @author lvdaxianer@yeah.net @date 2026-10-17 */
  public get observerFailureCount(): number { return this.failures; }

  /** @param kind - 观测类型 @param input - 关联字段和 metadata @param extra - 类型专属字段 @returns 已脱敏记录 @author lvdaxianer@yeah.net @date 2026-10-17 */
  private async write(kind: ObservabilityKind, input: ObservabilityInput, extra: Partial<Pick<ObservabilityRecord, 'level' | 'name' | 'value'>> = {}): Promise<ObservabilityRecord> {
    const fields = redactFields(input.fields, this.sensitivePaths, { maxNodes: Math.min(4096, Math.max(64, this.maxMetadataBytes)), maxDepth: 32 });
    const oversized = Buffer.byteLength(JSON.stringify(fields), 'utf8') > this.maxMetadataBytes;
    const record: ObservabilityRecord = { schemaVersion: OBSERVABILITY_SCHEMA_VERSION, kind, timestamp: stableTimestamp(this.clock), traceId: stable(input.traceId), runId: stable(input.runId), eventName: stable(input.eventName), fields: oversized ? { metadata: '[TRUNCATED]' } : fields, ...(oversized ? { truncated: true } : {}), ...extra };
    this.records.push(structuredClone(record));
    if (this.sink) {
      try { await this.sink.write(structuredClone(record)); } catch {
        this.failures += 1;
        this.records.push({ schemaVersion: OBSERVABILITY_SCHEMA_VERSION, kind: 'audit', timestamp: record.timestamp, traceId: record.traceId, runId: record.runId, eventName: 'observability.observer_failed', fields: { sourceEventName: record.eventName, sourceKind: record.kind, failureCount: this.failures } });
      }
    }
    return structuredClone(record);
  }
}

/** @param value - 未信任关联标识 @returns 稳定关联标识 @author lvdaxianer@yeah.net @date 2026-10-17 */
function stable(value: unknown): string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : 'unknown'; }

/** @param value - 未知日志级别 @returns 是否为允许级别 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isLogLevel(value: unknown): value is NonNullable<LogInput['level']> { return value === 'trace' || value === 'debug' || value === 'info' || value === 'warn' || value === 'error'; }

/** @param value - 未知指标名 @returns 稳定指标名 @author lvdaxianer@yeah.net @date 2026-10-17 */
function stableMetricName(value: unknown): string { return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(value) ? value : 'unknown.metric'; }

/** @param clock - 外部时钟 @returns 稳定 ISO 时间 @author lvdaxianer@yeah.net @date 2026-10-17 */
function stableTimestamp(clock: () => string): string {
  try { const value = clock(); return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : new Date(0).toISOString(); } catch { return new Date(0).toISOString(); }
}
