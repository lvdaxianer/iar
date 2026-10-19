/**
 * 实现上下文压缩候选的边界、事件、引用和状态一致性校验。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import {
  COMPACTION_LIMITS,
  REQUIRED_PRESERVED_FACTS,
  validateContract,
  type BehaviorContext,
  type CompactionResult,
  type ContractErrorResult,
  type ContractIssue,
  type EventEnvelope
} from '@iar/contracts';
import type { CompactionRequest } from './compaction.js';
import {
  collectEventIssues,
  containsStableString,
  isRecord,
  issue,
  pickStrings,
  recordValue
} from './compaction-helpers.js';

/** 校验模型结果、Runtime 元数据、输入事件和事实引用。 */
export function validateCompactionRequest(request: CompactionRequest):
  | { ok: true }
  | { ok: false; error: ContractErrorResult } {
  // 模型结果先通过最小协议 Schema，再读取任何业务字段。
  const schema = validateContract('compactionResult', request.result);
  // Schema 错误保留 Ajv 的字段路径，便于审计定位。
  if (!schema.ok) return schema;
  // 未通过 Schema 的结果不会进入任何跨字段读取。

  // 所有跨字段规则集中在同一份诊断列表中返回。
  const issues = [
    // Runtime 元数据不能由模型伪造。
    ...validateMetadata(request),
    // EventLog 边界必须保持可重放。
    ...validateEventSet(request),
    // 摘要引用必须回指可信事实。
    ...validateReferences(request.result, request)
  ];
  // 只有零 issue 才允许进入状态规范化阶段。
  return issues.length > 0
    ? { ok: false, error: { ...schemaError(), details: { issues } } }
    : { ok: true };
}
// 返回成功只表示候选可进入 Projector 哈希门禁，不代表已写入 EventLog。
// EventLog 追加仍需由 Orchestrator 显式完成。
// 这也使失败事件可以和上下文快照放进同一事务。

/** 构造压缩跨字段校验使用的稳定错误骨架。 */
function schemaError(): ContractErrorResult {
  // 该骨架只用于跨字段错误，字段诊断由调用方补齐。
  // 不携带模型原始文本，保持错误边界稳定。
  return {
    schemaVersion: 'iar.error/v1',
    code: 'contract.validation_failed',
    message: '上下文压缩候选校验失败',
    retryable: false
  };
}

/** 校验 Runtime 生成的边界、token 计数和必保留事实。 */
function validateMetadata(request: CompactionRequest): ContractIssue[] {
  // 诊断列表保持稳定顺序，便于测试和审计比较。
  const issues: ContractIssue[] = [];
  // 先处理标量元数据，再处理事件和模型对象。
  // 字符串字段必须非空，数字字段必须是有限非负整数。
  for (const [name, value] of Object.entries(request)) {
    // current、events、result 由专门校验器处理。
    if (['current', 'events', 'result'].includes(name)) continue;
    if (typeof value !== 'string' && typeof value !== 'number') {
      // 不接受对象、函数或数组作为 Runtime 元数据。
      issues.push(issue(`/${name}`, 'type', 'Runtime 元数据类型无效'));
    }
    // 空字符串不能作为事件边界或版本标识。
    if (isEmptyMetadata(value)) issues.push(issue(`/${name}`, 'min', 'Runtime 元数据不能为空或必须为非负整数'));
  }
  // 压缩不能把 token 数量变大。
  if (request.afterTokenCount > request.beforeTokenCount) {
    // 压缩方向必须是单调减少或保持不变。
    issues.push(issue('/afterTokenCount', 'maximum', '压缩后的 token 数不能大于压缩前'));
  }
  // 模型必须显式声明保留全部可执行关键字段。
  const preserved = new Set(request.result.preservedFacts);
  // 必保留字段由集中式常量定义，禁止调用方遗漏。
  for (const fact of REQUIRED_PRESERVED_FACTS) {
    if (!preserved.has(fact)) issues.push(issue('/preservedFacts', 'contains', `缺少必保留事实 ${fact}`));
  }
  return issues;
}
// 该函数不读取 summary 文本，摘要内容由 Schema 长度边界保护。
// 摘要文本永远不能替代状态字段校验。
// 关键字段哈希始终由 Runtime 重新计算。

/** 判断 Runtime 元数据是否为空或不是合法非负整数。 */
function isEmptyMetadata(value: unknown): boolean {
  // Number.isInteger 同时排除 NaN、Infinity 和小数。
  // 字符串和数字共用同一边界函数。
  // undefined 会由上一层的 type 检查报告。
  return (typeof value === 'string' && value.length === 0)
    || (typeof value === 'number' && (!Number.isInteger(value) || value < 0));
}

/** 校验事件契约、运行归属、ID 唯一性和压缩区间顺序。 */
function validateEventSet(request: CompactionRequest): ContractIssue[] {
  // Set 和 Map 同时记录唯一性与输入顺序。
  const issues: ContractIssue[] = [];
  const eventIds = new Set<string>();
  const indexes = new Map<string, number>();
  // indexes 保存输入顺序，不依赖事件时间的字符串排序。
  // 这也避免不同机器的时区格式影响边界判定。
  // 没有输入事件时无法证明摘要中的事实来源。
  if (!Array.isArray(request.events) || request.events.length === 0) {
    // 空事件集无法验证任何 reference。
    return [issue('/events', 'minItems', '压缩输入事件不能为空')];
  }
  if (request.events.length > COMPACTION_LIMITS.maxEvents) {
    return [issue('/events', 'maxItems', '压缩输入事件超过容量上限')];
  }
  // 事件数组的顺序就是压缩边界的语义顺序。
  // 每条事件都经过契约、归属、时间和唯一性校验。
  for (const [index, raw] of request.events.entries()) {
    // 单条事件的详细错误由 helper 负责，避免主流程分支漂移。
    issues.push(...collectEventIssues(request, raw, index, eventIds, indexes));
  }
  // 边界必须在输入事件中存在且不能与输出事件冲突。
  issues.push(...validateBoundaryIds(request, eventIds, indexes));
  // 边界检查放在事件采集后，才能安全比较索引。
  return issues;
}
// EventLog 事件本身仍是 source of truth，不会被摘要替代。

/** 校验边界事件存在、顺序正确并且不与输出事件冲突。 */
function validateBoundaryIds(request: CompactionRequest, eventIds: Set<string>, indexes: Map<string, number>): ContractIssue[] {
  // from/to/firstKept 都必须绑定不可变事件。
  const issues: ContractIssue[] = [];
  // 先检查存在性，再读取 Map 索引，避免非空断言掩盖缺失 ID。
  // 事件边界错误必须落到具体请求字段。
  // from、to 和 firstKept 都必须能回指 EventLog。
  for (const field of ['fromEventId', 'toEventId', 'firstKeptEntryId'] as const) {
    // 不存在的 ID 不能被模型摘要自行创造。
    if (!eventIds.has(request[field])) issues.push(issue(`/${field}`, 'reference', '压缩边界事件不存在'));
  }
  // firstKept 必须严格位于压缩终点之后，避免边界重叠。
  if (eventIds.has(request.fromEventId) && eventIds.has(request.toEventId)) {
    // 使用输入顺序作为 EventLog 的确定性边界。
    const from = indexes.get(request.fromEventId)!;
    const to = indexes.get(request.toEventId)!;
    // from 必须不晚于 to，保持压缩区间方向确定。
    if (from > to) issues.push(issue('/fromEventId', 'order', '压缩边界顺序无效'));
    if (eventIds.has(request.firstKeptEntryId) && indexes.get(request.firstKeptEntryId)! <= to) {
      issues.push(issue('/firstKeptEntryId', 'order', '保留事件必须位于压缩终点之后'));
    }
  }
  // 成功和失败事件都必须位于旧 EventLog 之后。
  // 事件日志中的 ID 必须与新生成事件隔离。
  if (eventIds.has(request.compactedEventId)) issues.push(issue('/compactedEventId', 'unique', '成功事件 ID 与输入事件冲突'));
  // 输出事件不能覆盖已有事实事件。
  if (eventIds.has(request.failureEventId)) issues.push(issue('/failureEventId', 'unique', '失败事件 ID 与输入事件冲突'));
  if (request.compactedEventId === request.failureEventId) issues.push(issue('/failureEventId', 'unique', '成功和失败事件 ID 不能相同'));
  return issues;
}
// 任一边界失败都必须保留旧上下文并发出失败事件。

/** 校验引用来源存在，并且目标能映射到可信事实。 */
function validateReferences(result: CompactionResult, request: CompactionRequest): ContractIssue[] {
  // 先防御数组类型，再建立只读来源索引。
  // 非数组输入由事件集合校验报告，避免这里再次抛出 TypeError。
  if (!Array.isArray(request.events)) return [issue('/events', 'array', '压缩输入事件必须是数组')];
  // Map 只保存通过普通对象检查的来源事件。
  const eventMap = new Map(request.events.filter(isRecord).map((event) => [event.eventId, event]));
  // 每条引用都必须有来源事件和可验证目标。
  // 任何一条引用失败都会阻止整个压缩候选。
  return result.references.flatMap((reference, index) => {
    // sourceEventId 是引用审计的第一跳。
    const event = eventMap.get(reference.sourceEventId);
    if (!event) return [issue(`/references/${index}/sourceEventId`, 'reference', '引用事件不存在')];
    return referenceMatchesFact(reference.resolvedTo, event, request.current)
      ? []
      : [issue(`/references/${index}/resolvedTo`, 'reference', '引用目标与可信事实不一致')];
  });
}
// references 的顺序保留模型输出顺序，便于审计对应关系。
// 该检查阻止模型仅凭自然语言摘要制造实体关系。

/** 判断引用目标是否出现在当前上下文或来源事件的稳定事实中。 */
function referenceMatchesFact(target: string, event: Record<string, unknown>, context: BehaviorContext): boolean {
  // 当前主语和已解析槽位是第一可信来源。
  if (target === context.subject.id || Object.values(context.slots).some((slot) => slot.value === target)) return true;
  // 如果当前视图尚未解析，允许来源事件提供稳定实体事实。
  // 来源事件中的稳定字段支持“第一个服务 -> test1”这类解析。
  return containsStableString(event.payload, target);
}

/** 将模型状态片段规范化为完整 BehaviorContext。 */
export function normalizeCompactionState(state: Record<string, unknown>, current: BehaviorContext): BehaviorContext {
  // 规范化结果从可信上下文复制，确保候选不能删除未显式返回的状态。
  const next = structuredClone(current);
  // clone 先于任何 merge，保证输入对象也不会被修改。
  // 规范化阶段不会写入 integrity 元数据。
  // 模型缺少 Runtime 元数据时，始终保留可信旧字段。
  const subject = recordValue(state.subject);
  // subject 的来源字段不允许被自然语言 name 替代。
  if (subject) next.subject = { ...next.subject, ...pickStrings(subject, ['type', 'id', 'status', 'source', 'sourceEventId']) };
  // README 和 Prompt 均允许 string 或 { value, status } 的 intent。
  const intent = state.intent;
  if (typeof intent === 'string') next.intent = intent;
  // 对象形式只读取 value，不把解释状态写入执行状态。
  if (isRecord(intent) && typeof intent.value === 'string') next.intent = intent.value;
  // 其余可执行字段通过白名单合并。
  // 以下片段只合并允许字段，未知字段不会进入执行上下文。
  mergeObject(next.action, recordValue(state.action), ['name', 'status']);
  mergeObject(next.route, recordValue(state.route), ['functionId', 'pluginId']);
  if (state.slots !== undefined) next.slots = structuredClone(state.slots) as BehaviorContext['slots'];
  // slots 的完整结构随后由 Projector Schema 再次验证。
  // Projector 哈希校验最终决定候选是否可接受。
  mergeObject(next.workflow, recordValue(state.workflow), ['workflowId', 'currentStep', 'status']);
  mergeObject(next.pending, recordValue(state.pending), ['kind', 'status']);
  mergeObject(next.confirmation, recordValue(state.confirmation), ['state', 'scopeHash', 'confirmedAt']);
  return next;
}
// 规范化之后仍必须调用 replaceIfIntegrityMatches。
// 该调用阻止 subject、route、workflow 或 confirmation 被改变。

/** 只合并协议允许的字段，避免模型额外字段污染状态。 */
function mergeObject<T extends Record<string, unknown>>(target: T, source: Record<string, unknown> | undefined, fields: readonly string[]): void {
  // 未返回的片段保持旧状态，不被 undefined 覆盖。
  if (source) Object.assign(target, pickStrings(source, fields));
}
