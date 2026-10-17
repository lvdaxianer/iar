/*
 * 验证版本化 Intent Model Prompt 的公开契约与正常输入路径。
 * 本文件只覆盖 Prompt 文本、候选顺序、深拷贝和基础字段校验。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIntentDecisionInput, INTENT_DECISION_PROMPT_VERSION, INTENT_DECISION_SYSTEM_PROMPT } from '../../../packages/decision/src/index.js';
import type { DecisionRequest } from '../../../packages/decision/src/types.js';

/**
 * 创建包含嵌套可变字段的稳定决策请求，供正常路径测试复用。
 *
 * @returns 可供 Prompt builder 使用的合法决策请求
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function requestFixture(): DecisionRequest {
  return {
    decisionType: 'function.select',
    decisionVersion: 'runtime.v1',
    threshold: 0.8,
    candidates: [
      { candidateId: 'candidate-b', priority: 2, specificity: 1, requiredSlots: ['subject'] },
      { candidateId: 'candidate-a', priority: 1, specificity: 1, evidenceCodes: ['intent.match'] }
    ]
  };
}

/**
 * 读取 Prompt 输出中的结构化 request，集中处理测试用的 JSON 形状断言。
 *
 * @param input - builder 返回的 JSON-safe Prompt 输入
 * @returns Prompt 交给模型的结构化决策请求
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function promptRequest(input: ReturnType<typeof buildIntentDecisionInput>): Record<string, unknown> {
  assert.ok(typeof input === 'object' && input !== null && !Array.isArray(input));
  const request = (input as Record<string, unknown>).request;
  assert.ok(typeof request === 'object' && request !== null && !Array.isArray(request));
  return request as Record<string, unknown>;
}

/*
 * 场景：版本是模型路由、审计和回放的稳定标识。
 * 输入边界：不依赖 request，直接检查公开版本常量。
 * 失败语义：版本漂移会让同一模型 profile 使用未审计 Prompt。
 * 断言目的：确认版本字符串仍是契约规定的固定值。
 */
test('exports the fixed Intent Decision Prompt version', () => {
  // 固定版本断言失败时，调用方无法安全关联历史 Prompt 和决策记录。
  assert.equal(INTENT_DECISION_PROMPT_VERSION, 'iar.intent-decision-prompt/v1');
});

/*
 * 场景：模型输出必须被限制在公共 DecisionResult 协议内。
 * 输入边界：把系统 Prompt 转成小写后逐项查找不可缺失的安全词。
 * 失败语义：缺少任一约束都可能允许 Markdown、扩展候选或越权动作。
 * 断言目的：确保 schemaVersion、复制规则和非授权边界同时存在。
 */
test('system prompt contains the complete JSON-only decision boundary', () => {
  // 将检查集中在公开系统 Prompt，避免通过实现细节间接放宽模型协议。
  // 这里的输入没有候选数据，专门验证静态安全边界是否完整。
  const prompt = INTENT_DECISION_SYSTEM_PROMPT.toLowerCase();
  const requiredTerms = [
    'json only',
    'markdown',
    'iar.decision/v1',
    'schemaversion must equal iar.decision/v1 exactly',
    'decisiontype',
    'decisionversion',
    'candidateids',
    'preserve candidateids order',
    'finite candidates',
    'choice must be one of candidateids',
    'for non-choice statuses, do not include choice or score',
    'create candidates',
    'grant capabilities',
    'authorize actions',
    'execute plugins'
  ];

  // 逐项检查约束词，避免删除单个安全边界后测试仍然通过。
  // 任何缺失词都应把测试定位到 Prompt 契约，而不是运行时输入校验。
  // 该组断言失败表示模型可见的安全指令已经不完整。
  requiredTerms.forEach((term) => assert.match(prompt, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))));
});

/*
 * 场景：合法请求进入模型前需要补齐 Prompt 元数据。
 * 输入边界：使用两个顺序明确、指标有限的候选作为最小正常请求。
 * 失败语义：字段丢失或重排会破坏模型 choice 与规则候选的对应关系。
 * 断言目的：确认版本、协议字段和 candidateIds 顺序被完整保留。
 */
test('builds a versioned input with ordered candidateIds and finite candidates', () => {
  // 从合法最小请求开始，隔离构造成功路径与异常路径的测试职责。
  // 后续断言失败时应能直接定位到字段复制或候选顺序问题。
  const input = buildIntentDecisionInput(requestFixture());
  const request = promptRequest(input);

  // 关键协议字段必须与调用方请求保持一致。
  // 这些断言失败表示 builder 改写了调用方约束或候选顺序。
  assert.equal(request.decisionType, 'function.select');
  assert.equal(request.decisionVersion, 'runtime.v1');
  assert.equal(request.threshold, 0.8);
  assert.deepEqual(request.candidateIds, ['candidate-b', 'candidate-a']);
  assert.deepEqual(
    (request.candidates as Array<Record<string, unknown>>).map((candidate) => candidate.candidateId),
    ['candidate-b', 'candidate-a']
  );
  // 顶层 Prompt 版本和系统文本必须使用同一固定导出。
  // 这组断言失败表示返回对象无法被路由层按版本审计。
  assert.equal((input as Record<string, unknown>).promptVersion, INTENT_DECISION_PROMPT_VERSION);
  assert.equal((input as Record<string, unknown>).systemPrompt, INTENT_DECISION_SYSTEM_PROMPT);
});

/*
 * 场景：调用方可能在模型调用前修改 builder 返回值。
 * 输入边界：请求包含 requiredSlots 嵌套数组，覆盖一层以上的可变引用。
 * 失败语义：共享引用会让调用方修改原始规则请求或污染审计输入。
 * 断言目的：确认输出可 JSON 序列化且候选对象、槽位数组均为深拷贝。
 */
test('returns a JSON-safe deep copy isolated from the source request', () => {
  // 先保留原请求引用，再单独取得返回快照，确保修改行为可被对比。
  // 测试输入特意包含 requiredSlots，覆盖嵌套数组而非只有顶层对象。
  const request = requestFixture();
  const input = buildIntentDecisionInput(request);
  const copiedRequest = promptRequest(input);
  const copiedCandidates = copiedRequest.candidates as Array<Record<string, unknown>>;
  const copiedCandidate = copiedCandidates[0];
  assert.ok(copiedCandidate);
  const copiedSlots = copiedCandidate.requiredSlots as string[];

  // 先确认完整输出可序列化，再故意修改返回值验证深拷贝。
  // 若序列化或隔离失败，后续断言应明确指出具体的嵌套引用泄漏。
  assert.doesNotThrow(() => JSON.stringify(input));
  copiedCandidate.candidateId = 'changed';
  copiedSlots.push('changed');

  // 原请求中的候选和槽位不应受返回值修改影响。
  // 这些断言失败意味着 builder 把用户可变结构带进了 Prompt 输入。
  assert.equal(request.candidates[0]?.candidateId, 'candidate-b');
  assert.deepEqual(request.candidates[0]?.requiredSlots, ['subject']);
  assert.equal(copiedRequest.candidateIds?.toString(), 'candidate-b,candidate-a');
});

/*
 * 场景：多个请求可能连续进入同一模型 gateway。
 * 输入边界：第二次请求使用不同候选，验证调用级别而非字段级别隔离。
 * 失败语义：共享数组会让一次调用追加的候选出现在另一份 Prompt 中。
 * 断言目的：确认 request、candidates 和 candidateIds 都不复用可变引用。
 */
test('does not share mutable references between different request inputs', () => {
  // 两次调用使用独立 fixture，避免把同一个输入对象误当成隔离证据。
  // 第二份请求只保留一个候选，使候选标识污染更容易被识别。
  const first = buildIntentDecisionInput(requestFixture()) as Record<string, unknown>;
  const secondRequest = requestFixture();
  secondRequest.candidates = [{ candidateId: 'candidate-c', priority: 3, specificity: 2 }];
  const second = buildIntentDecisionInput(secondRequest) as Record<string, unknown>;

  // 顶层 request、候选集合和候选标识列表都应分别分配。
  // 任一引用相同都表示不同决策调用之间存在污染路径。
  const firstPromptRequest = first.request as Record<string, unknown>;
  const secondPromptRequest = second.request as Record<string, unknown>;
  assert.notEqual(first.request, second.request);
  assert.notEqual(firstPromptRequest.candidates, secondPromptRequest.candidates);
  assert.notEqual(firstPromptRequest.candidateIds, secondPromptRequest.candidateIds);

  // 修改第一份输出不能污染第二份输出。
  // 该断言失败时，模型看到的候选集合会依赖之前的调用历史。
  (firstPromptRequest.candidateIds as string[]).push('candidate-extra');
  assert.deepEqual(secondPromptRequest.candidateIds, ['candidate-c']);
});

/*
 * 场景：threshold 可能携带 NaN、Infinity 或超出闭区间的数值。
 * 输入边界：逐一注入四类非法值，覆盖非有限和上下界越界路径。
 * 失败语义：若校验滞后，JSON.stringify 会把非法数字静默改成 null。
 * 断言目的：要求 builder 在序列化前抛出稳定的 threshold 错误摘要。
 */
test('rejects invalid threshold values before serialization', () => {
  // 非有限值和边界外值都必须在构造输出前失败，不能依赖序列化兜底。
  // 循环中的每次断言都检查同一稳定摘要，保证错误契约不随输入漂移。
  [Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.01].forEach((threshold) => {
    // 每个非法数值都必须独立构造请求，避免测试状态互相污染。
    // 错误摘要不应随 NaN、Infinity 或具体越界方向产生不稳定分支。
    const request = { ...requestFixture(), threshold };
    assert.throws(
      () => buildIntentDecisionInput(request),
      (error: unknown) => error instanceof TypeError && error.message === 'Intent Decision request 无效：threshold 必须是 0 到 1 的有限数'
    );
  });
});

/*
 * 场景：候选排序指标可能被 JSON 静默变成 null。
 * 输入边界：分别把 priority 和 specificity 替换为 NaN、Infinity。
 * 失败语义：模型若收到 null 指标，候选排序将失去可审计的数值含义。
 * 断言目的：确认两个候选数值字段都在输入边界执行有限数校验。
 */
test('rejects non-finite candidate priority and specificity', () => {
  // 两种排序指标分别注入非有限值，覆盖字段级而非请求级的数值防护。
  // 合法候选仍保留在集合中，用来证明失败原因确实来自被替换的指标。
  [
    { priority: Number.NaN, specificity: 1 },
    { priority: 1, specificity: Number.POSITIVE_INFINITY }
  ].forEach((values) => {
    // 只替换一个候选的数值，保留其余请求结构作为对照。
    // 这样失败可以归因于具体指标，而不是候选结构本身非法。
    const request = requestFixture();
    const firstCandidate = request.candidates[0];
    const secondCandidate = request.candidates[1];
    assert.ok(firstCandidate);
    assert.ok(secondCandidate);
    request.candidates = [
      { candidateId: firstCandidate.candidateId, priority: values.priority, specificity: values.specificity },
      secondCandidate
    ];
    assert.throws(
      () => buildIntentDecisionInput(request),
      (error: unknown) => error instanceof TypeError && error.message === 'Intent Decision request 无效：candidate priority 和 specificity 必须是有限数'
    );
  });
});

/*
 * 场景：重复 candidateId 会破坏模型 choice 到候选的唯一映射。
 * 输入边界：仅复制第一个候选的标识，保持两项其它结构都合法。
 * 失败语义：若重复标识进入 Prompt，模型选择无法可靠回指规则候选。
 * 断言目的：确认重复标识在 builder 边界产生稳定错误，而非被覆盖。
 */
test('rejects duplicate candidateIds', () => {
  const request = requestFixture();
  const firstCandidate = request.candidates[0];
  const secondCandidate = request.candidates[1];
  assert.ok(firstCandidate);
  assert.ok(secondCandidate);

  // 构造与第一个候选同名的第二项，保持其它字段合法以隔离重复校验。
  // 恶意输入只改变唯一性条件，避免测试混入数值或数组错误。
  request.candidates = [
    firstCandidate,
    { candidateId: 'candidate-b', priority: secondCandidate.priority, specificity: secondCandidate.specificity }
  ];

  // 重复标识必须产生稳定、可审计的错误摘要。
  // 断言失败表示 builder 允许不可逆的 choice 歧义进入模型层。
  assert.throws(
    () => buildIntentDecisionInput(request),
    (error: unknown) => error instanceof TypeError && error.message === 'Intent Decision request 无效：candidateId 必须唯一'
  );
});
