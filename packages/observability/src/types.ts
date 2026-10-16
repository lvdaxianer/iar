/**
 * 定义 trace、metric、structured-log 和 audit 共用的版本化记录边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { JsonValue } from '@iar/contracts';

/** 当前观测记录的兼容版本。 */
export const OBSERVABILITY_SCHEMA_VERSION = 'iar.observability/v1' as const;

/** 观测记录的四种用途。 */
export type ObservabilityKind = 'log' | 'trace' | 'metric' | 'audit';

/** 结构化日志级别。 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/** 记录中允许输出的已脱敏字段。 */
export type ObservabilityRecord = {
  schemaVersion: typeof OBSERVABILITY_SCHEMA_VERSION;
  kind: ObservabilityKind;
  timestamp: string;
  traceId: string;
  runId: string;
  eventName: string;
  fields: Record<string, JsonValue>;
  level?: LogLevel;
  name?: string;
  value?: number;
  truncated?: boolean;
};

/** 记录方法接收的字段。脱敏前允许 unknown，不能直接写入 sink。 */
export type ObservabilityInput = {
  traceId: string;
  runId: string;
  eventName: string;
  fields?: Record<string, unknown>;
};

/** 结构化日志输入。 */
export type LogInput = ObservabilityInput & { level: LogLevel };

/** 指标输入。 */
export type MetricInput = ObservabilityInput & { name: string; value: number };

/** 可注入的日志、trace、metric 或 audit 输出端。 */
export type ObserverSink = { write(record: ObservabilityRecord): void | Promise<void> };

/** Recorder 的资源和脱敏配置。 */
export type ObservabilityOptions = {
  sink?: ObserverSink;
  clock?: () => string;
  sensitivePaths?: readonly string[];
  maxMetadataBytes?: number;
};

/** 脱敏器的有限遍历配置。 */
export type RedactionOptions = { maxNodes?: number; maxDepth?: number };
