/**
 * 提供上下文压缩服务共享的边界、错误和 JSON 辅助函数。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import {
  ERROR_CODES,
  validateContract,
  type BehaviorContext,
  type ContractErrorResult,
  type ContractIssue,
  type EventEnvelope
} from '@iar/contracts';
import type { CompactionFailedEvent, CompactionRequest } from './compaction.js';

/** 构造带字段诊断的压缩校验错误。 */
export function compactionError(issues: ContractIssue[]): ContractErrorResult {
  // 统一错误码使失败事件和调用方重试策略可编程识别。
  return {
    // 版本字段保持与 contracts 包一致。
    schemaVersion: 'iar.error/v1',
    // 所有候选校验失败都归入同一稳定错误码。
    code: ERROR_CODES.CONTRACT_VALIDATION_FAILED,
    message: '上下文压缩候选校验失败',
    // 压缩失败默认不可自动重试，需重新生成候选。
    retryable: false,
    details: { issues }
  };
}
// 错误结构不包含原始模型输出，避免日志和事件泄露。
// details.issues 保持 JSON 可序列化，供失败事件和测试复用。
// 调用方可以安全地将 details 写入审计记录。
// issue 不携带原始异常对象或堆栈。

/** 创建固定形状的字段问题。 */
export function issue(path: string, keyword: string, message: string): ContractIssue {
  // 字段路径使用 JSON Pointer 风格，避免暴露 Ajv 实例对象。
  return { path, keyword, message };
}
// issue 是跨模块共享的最小诊断单元。

/** 判断 JSON 载荷是否为普通对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  // 数组不是事件载荷或状态片段的普通对象。
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
// 该窄化不对普通对象字段做额外信任承诺。

/** 读取候选对象字段且拒绝数组和 null。 */
export function recordValue(value: unknown): Record<string, unknown> | undefined {
  // 该窄化函数集中处理 null 和数组边界。
  return isRecord(value) ? value : undefined;
}
// undefined 让规范化逻辑自然保留可信旧字段。

/** 从候选对象中提取允许的字符串字段。 */
export function pickStrings(source: Record<string, unknown>, fields: readonly string[]): Record<string, string> {
  // 只复制白名单字段，拒绝模型注入的未知属性。
  // Object.fromEntries 保持输出为普通 JSON 对象。
  return Object.fromEntries(fields.flatMap((field) => typeof source[field] === 'string' ? [[field, source[field] as string]] : []));
}
// 状态对象的枚举值由各自专用 Schema 再次确认。

/** 在事件 JSON 中查找可审计的稳定字符串事实。 */
export function containsStableString(value: unknown, target: string): boolean {
  // 先比较叶子，再递归遍历数组和对象。
  if (value === target) return true;
  // 数组中的候选值同样可能来自事件事实。
  if (Array.isArray(value)) return value.some((item) => containsStableString(item, target));
  // 非对象原子值不再展开。
  if (!isRecord(value)) return false;
  // 关键字段命中后不依赖模型的自然语言摘要。
  return Object.entries(value).some(([key, item]) => stableKeys().has(key) && item === target)
    // 递归分支允许事件嵌套 payload 仍可被引用。
    || Object.values(value).some((item) => containsStableString(item, target));
}
// 引用验证不把 summary 当作事实来源。
// 递归查找只用于引用证据，不会修改事件或上下文。
// 事件事实优先于模型的自由文本解释。
// 这样可避免摘要注入未发生的实体关系。

/** 返回引用解析允许使用的稳定字段名。 */
function stableKeys(): ReadonlySet<string> {
  // 这些字段在事件协议中承载稳定实体或槽位值。
  return new Set<string>(['id', 'subjectId', 'functionId', 'pluginId', 'value']);
}

/** 返回非空字符串，否则使用安全回退值。 */
export function safeString(value: unknown, fallback: string): string {
  // 失败审计事件必须始终具有可写入的字符串标识。
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}
// 该函数不截断稳定 ID，长度边界由上游 EventEnvelope Schema 负责。
// fallback 只用于失败事件，正常请求仍会被元数据校验拒绝。

/** 生成不与输入或成功事件冲突的失败事件 ID。 */
export function failureEventId(request: CompactionRequest, context: BehaviorContext): string {
  // 非法请求也可能带有 null 事件集合，因此先防御数组边界。
  const ids = (Array.isArray(request.events) ? request.events : [])
    // 只把字符串 ID 纳入冲突集合。
    .filter(isRecord)
    .map((event) => event.eventId)
    .filter((id): id is string => typeof id === 'string');
  const used = new Set<string>(ids);
  // 优先复用调用方提供的 ID，只有冲突时才生成后缀。
  const base = safeString(request.failureEventId, `context-compaction-failed:${context.integrity.lastEventId}`);
  // 即使 request 的 failureEventId 与旧事件冲突，也必须有可追加事件。
  if (!used.has(base) && base !== request.compactedEventId) return base;
  return nextAvailableId(base, used, request.compactedEventId);
}
// ID 回退只解决冲突，不掩盖原始校验错误。

/** 在已有事件集合之外寻找确定性的后缀 ID。 */
function nextAvailableId(base: string, used: ReadonlySet<string>, compactedEventId: string): string {
  // 递增后缀保持同一请求内的确定性。
  let suffix = 1;
  // 从 1 开始避免与原始请求 ID 相同。
  let candidate = `${base}:${suffix}`;
  while (used.has(candidate) || candidate === compactedEventId) {
    // 直到同时避开已有输入和成功事件 ID。
    suffix += 1;
    candidate = `${base}:${suffix}`;
  }
  // 循环结束时 candidate 已避开所有已知碰撞。
  return candidate;
}

/** 构造固定字段的失败兜底事件。 */
export function fallbackFailureEvent(context: BehaviorContext): CompactionFailedEvent {
  // 固定兜底不依赖损坏请求中的 run/correlation 字段。
  const event: CompactionFailedEvent = {
    // 固定 schemaVersion 避免损坏请求影响兜底事件。
    schemaVersion: 'iar.event/v1',
    eventId: `context-compaction-failed:${context.integrity.lastEventId}`,
    eventName: 'context.compaction_failed',
    occurredAt: '1970-01-01T00:00:00.000Z',
    runId: 'unknown-run',
    correlationId: 'unknown-correlation',
    payload: {
      // previousContextHash 是旧视图保留的证据。
      reasonCode: ERROR_CODES.CONTRACT_VALIDATION_FAILED,
      message: '上下文压缩候选校验失败',
      previousContextHash: context.integrity.criticalFieldHash
    }
  };
  // 即使主路径校验失败，兜底仍需经过同一公共入口。
  return validateFallbackEvent(event);
}
// 兜底事件仍然携带 previousContextHash，便于恢复审计。

/** 确保固定兜底事件也经过公共 EventEnvelope 校验。 */
function validateFallbackEvent(event: CompactionFailedEvent): CompactionFailedEvent {
  // 未来修改载荷字段时，这里会立即阻止非法事件返回。
  const validation = validateContract('event', event);
  // 这里理论上不会失败，但必须保留最后一道断言。
  if (!validation.ok) throw new Error('压缩失败事件兜底契约无效');
  // 返回前确保调用方永远拿到可写入的事件。
  return event;
}
// 兜底校验失败属于程序错误，不应静默返回非法事件。

/** 收集单个输入事件的契约、归属和时间问题。 */
export function collectEventIssues(
  request: CompactionRequest,
  raw: unknown,
  index: number,
  eventIds: Set<string>,
  indexes: Map<string, number>
): ContractIssue[] {
  // 原始输入先经过普通对象判断，再读取任何事件属性。
  if (!isRecord(raw)) return [issue(`/events/${index}`, 'object', '压缩输入事件必须是对象')];
  // 通过后才允许读取 eventId、runId 等字段。
  const event = raw as unknown as EventEnvelope;
  // 单条事件的所有诊断保持同一顺序。
  const issues: ContractIssue[] = [];
  // EventEnvelope 的 payload 专用 Schema 在 validateContract 内完成。
  if (!validateContract('event', event).ok) issues.push(issue(`/events/${index}`, 'event', '压缩输入事件契约无效'));
  // 事件 ID 是后续边界 Map 的主键。
  if (eventIds.has(event.eventId)) issues.push(issue(`/events/${index}/eventId`, 'unique', '输入事件 ID 重复'));
  eventIds.add(event.eventId);
  indexes.set(event.eventId, index);
  if (event.runId !== request.runId) issues.push(issue(`/events/${index}/runId`, 'const', '事件不属于当前运行'));
  // runId 与 correlationId 双重绑定防止跨运行引用。
  if (event.correlationId !== request.correlationId) issues.push(issue(`/events/${index}/correlationId`, 'const', '事件不属于当前链路'));
  issues.push(...eventTimeIssues(request.events, index, event));
  // 返回后由上层统一追加边界和引用问题。
  return issues;
}
// 事件问题返回后由 validation 模块决定是否拒绝整批候选。
// helper 不负责改变 request.events，只返回诊断。
// 这保证失败路径可以继续返回旧视图副本。
// 事件集合仍由调用方持有其不可变生命周期。
// helper 只做纯函数式边界检查。

/** 校验事件时间戳可解析且按输入顺序单调不递减。 */
function eventTimeIssues(events: readonly EventEnvelope[], index: number, event: EventEnvelope): ContractIssue[] {
  // Date.parse 将非法时间转换为 NaN，再统一转成稳定 issue。
  const currentTime = Date.parse(event.occurredAt);
  // 取前一条事件作为输入顺序参照。
  const previous = index > 0 ? events[index - 1] : undefined;
  // 前一项可能是非法 null，必须继续保持稳定失败而非抛异常。
  const previousTime = previous && isRecord(previous) ? Date.parse(String(previous.occurredAt)) : currentTime;
  // 时间不能逆序，否则压缩区间无法确定。
  return !Number.isFinite(currentTime) || currentTime < previousTime
    ? [issue(`/events/${index}/occurredAt`, 'order', '事件时间戳无效或倒序')]
    : [];
}
