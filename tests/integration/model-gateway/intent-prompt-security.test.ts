/*
 * 验证 Intent Model Prompt builder 的 JSON 边界和恶意输入防护。
 * 每个场景都确认非法结构不会产生半合法 Prompt，也不会泄露原始异常内容。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIntentDecisionInput } from '@iar/decision';
import type { DecisionRequest } from '@iar/decision';

/**
 * 创建安全的基础请求，供恶意输入测试按场景替换单个结构。
 *
 * @returns 可作为安全测试起点的合法决策请求
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
 * 断言动作只抛出不泄露原始内容的稳定 TypeError。
 *
 * @param action - 预期失败的 builder 调用
 * @param expectedMessage - 对外稳定的错误摘要
 * @returns 无返回值；断言失败时由 node:test 抛出异常
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertStableError(action: () => unknown, expectedMessage: string): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof TypeError && error.message === expectedMessage
  );
}

/*
 * 场景：最终 JSON 边界可能由运行时或宿主实现抛错。
 * 输入边界：替换 JSON.stringify，使失败发生在已规范化对象的最终边界。
 * 失败语义：底层异常 message 不能暴露给调用方，也不能返回半合法输入。
 * 断言目的：确认失败统一收敛为稳定的“输入必须可 JSON 序列化”。
 */
test('rejects JSON serialization failures with a stable TypeError', () => {
  const request = requestFixture();
  const originalStringify = JSON.stringify;

  // 模拟最终 JSON.stringify 失败，验证 builder 不返回半合法结果。
  JSON.stringify = (() => { throw new Error('serialization failure'); }) as typeof JSON.stringify;
  try {
    // 失败信息只能描述输入不可序列化，不能暴露底层异常文本。
    // 若断言失败，表示 JSON 边界把实现细节泄露成了公开协议。
    assertStableError(() => buildIntentDecisionInput(request), 'Intent Decision request 无效：输入必须可 JSON 序列化');
  } finally {
    // 无论断言是否成功都恢复全局函数，避免污染其它测试。
    JSON.stringify = originalStringify;
  }
});

/*
 * 场景：稀疏数组会被 JSON.stringify 静默转为 null。
 * 输入边界：删除中间候选索引，模拟规则层返回缺口数组。
 * 失败语义：null 候选会让模型误以为候选集合包含一个协议对象。
 * 断言目的：确认 builder 在读取候选前识别稀疏结构并稳定失败。
 */
test('rejects sparse candidates arrays', () => {
  const request = requestFixture();
  const candidates = [...request.candidates] as Array<DecisionRequest['candidates'][number]>;

  // 删除中间索引制造稀疏数组，不能让 builder 生成 candidates[1] = null。
  delete candidates[1];
  request.candidates = candidates;

  // 错误摘要应明确指出数组必须稠密且安全。
  // 断言失败意味着数组缺口可能绕过有限候选约束进入 Prompt。
  assertStableError(() => buildIntentDecisionInput(request), 'Intent Decision request 无效：candidates 必须是安全稠密数组');
});

/*
 * 场景：own toJSON 可以在 JSON.stringify 前改写整个候选数组。
 * 输入边界：给 candidates 数组挂载非枚举 toJSON，模拟恶意序列化钩子。
 * 失败语义：模型可能收到 rewritten 对象而不是规则层提供的候选集合。
 * 断言目的：确认数组 own 属性白名单不受枚举性或 toJSON 影响。
 */
test('rejects candidates arrays with own toJSON or extra properties', () => {
  const request = requestFixture();
  const candidates = [...request.candidates] as Array<DecisionRequest['candidates'][number]> & { toJSON?: () => unknown };

  // 恶意 toJSON 返回与候选协议无关的对象，必须在 JSON 边界之前拦截。
  Object.defineProperty(candidates, 'toJSON', { value: () => ({ rewritten: true }), enumerable: false });
  request.candidates = candidates;

  // 数组只允许 length 和连续索引 own 属性。
  // 断言失败表示自定义序列化逻辑可以绕过候选协议边界。
  assertStableError(() => buildIntentDecisionInput(request), 'Intent Decision request 无效：candidates 必须是安全稠密数组');
});

/*
 * 场景：候选 accessor 可在校验和复制之间改变字段值。
 * 输入边界：用 priority getter 伪装成合法数据属性，观察 descriptor 校验。
 * 失败语义：一次读取通过而另一次读取变化，会破坏有限数值和审计一致性。
 * 断言目的：确认候选字段只能是可枚举、稳定的数据属性。
 */
test('rejects candidate accessor properties', () => {
  const request = requestFixture();
  const firstCandidate = request.candidates[0];
  const secondCandidate = request.candidates[1];
  assert.ok(firstCandidate);
  assert.ok(secondCandidate);
  const accessorCandidate = { candidateId: firstCandidate.candidateId, specificity: firstCandidate.specificity } as Record<string, unknown>;

  // priority 使用 getter，防止一次读取通过、另一次读取返回不同语义。
  Object.defineProperty(accessorCandidate, 'priority', { enumerable: true, get: () => 2 });
  request.candidates = [accessorCandidate as unknown as typeof firstCandidate, secondCandidate];

  // accessor 不能被 JSON.stringify 或 normalize 隐式解释。
  // 断言失败表示调用方可以借助 getter 改写已校验的候选语义。
  assertStableError(() => buildIntentDecisionInput(request), 'Intent Decision request 无效：candidate 字段必须是可枚举数据属性且只包含声明字段');
});

/*
 * 场景：非枚举字段会被 JSON.stringify 静默丢弃。
 * 输入边界：把合法 priority 改成非枚举 own 属性，模拟字段隐藏。
 * 失败语义：模型收到缺失指标后仍可能继续做不可审计的选择。
 * 断言目的：确认所有会进入协议的候选字段都显式可枚举。
 */
test('rejects non-enumerable candidate fields', () => {
  const request = requestFixture();
  const firstCandidate = request.candidates[0];
  const secondCandidate = request.candidates[1];
  assert.ok(firstCandidate);
  assert.ok(secondCandidate);
  const hiddenCandidate = { ...firstCandidate } as Record<string, unknown>;

  // 将合法 priority 隐藏为非枚举 own 属性，模拟静默字段丢失。
  Object.defineProperty(hiddenCandidate, 'priority', { value: firstCandidate.priority, enumerable: false, writable: true });
  request.candidates = [hiddenCandidate as unknown as typeof firstCandidate, secondCandidate];

  // 必须在构造 Prompt 前报告结构错误。
  // 断言失败表示 JSON 序列化正在替 builder 静默决定协议字段。
  assertStableError(() => buildIntentDecisionInput(request), 'Intent Decision request 无效：candidate 字段必须是可枚举数据属性且只包含声明字段');
});

/*
 * 场景：原始 accessor TypeError 可能伪装成内部错误前缀。
 * 输入边界：threshold getter 主动抛出带敏感片段的 TypeError。
 * 失败语义：按 message 判断内部错误会把原始异常文本直接泄露出去。
 * 断言目的：确认公开错误只保留稳定的通用结构摘要。
 */
test('does not leak a prefixed raw TypeError from request accessors', () => {
  const request = { ...requestFixture() } as Record<string, unknown>;

  // threshold getter 直接抛出带内部前缀的敏感文本。
  Object.defineProperty(request, 'threshold', {
    enumerable: true,
    get: () => { throw new TypeError('Intent Decision request 无效：secret-internal-message'); }
  });

  // 对外只能得到通用结构错误，不能得到 getter 的原始 message。
  // 断言失败表示异常分类依赖可伪造的 message 前缀。
  assertStableError(() => buildIntentDecisionInput(request as unknown as DecisionRequest), 'Intent Decision request 无效：请求结构无效');
});

/*
 * 场景：Proxy own trap 可以在枚举字段期间抛出伪装前缀异常。
 * 输入边界：只让 threshold 描述符触发原始 TypeError，其余字段保持合法。
 * 失败语义：Proxy 元操作异常不能携带内部文本穿透输入边界。
 * 断言目的：确认非专用内部错误统一转换为稳定结构错误。
 */
test('does not leak a prefixed raw TypeError from request proxies', () => {
  const request = new Proxy(requestFixture(), {
    getOwnPropertyDescriptor(target, property) {
      // own trap 伪造内部错误，不能穿透 builder 边界。
      if (property === 'threshold') throw new TypeError('Intent Decision request 无效：proxy-secret');
      return Reflect.getOwnPropertyDescriptor(target, property);
    }
  });

  // 错误类型和摘要都必须由 builder 控制。
  // 断言失败表示底层 Proxy trap 获得了错误输出的控制权。
  assertStableError(() => buildIntentDecisionInput(request), 'Intent Decision request 无效：请求结构无效');
});

/*
 * 场景：candidateId 在初次校验后被 get trap 改写。
 * 输入边界：前两次读取返回合法标识，后续读取返回 undefined。
 * 失败语义：直接 normalize 原 Proxy 会生成 candidates [{}] 或 candidateIds [null]。
 * 断言目的：确认受控快照失败时不输出任何半合法 Prompt。
 */
test('rejects candidate proxies that mutate candidateId after validation', () => {
  const request = requestFixture();
  const firstCandidate = request.candidates[0];
  const secondCandidate = request.candidates[1];
  assert.ok(firstCandidate);
  assert.ok(secondCandidate);
  let candidateIdReads = 0;
  const mutableCandidate = new Proxy(firstCandidate, {
    get(target, property, receiver) {
      // 前两次读取服务于原始校验，后续读取返回缺失值模拟竞态改写。
      if (property === 'candidateId') {
        candidateIdReads += 1;
        return candidateIdReads <= 2 ? target.candidateId : undefined;
      }
      return Reflect.get(target, property, receiver);
    }
  });
  request.candidates = [mutableCandidate, secondCandidate];
  let output: ReturnType<typeof buildIntentDecisionInput> | undefined;

  // structuredClone 失败时必须抛稳定序列化错误，而不是输出半合法 JSON。
  // 输出变量保持 undefined，证明失败路径没有交付部分构造结果。
  assertStableError(() => { output = buildIntentDecisionInput(request); }, 'Intent Decision request 无效：输入必须可 JSON 序列化');
  assert.equal(output, undefined);
});

/*
 * 场景：threshold 在初次校验后被 get trap 改为 Infinity。
 * 输入边界：校验阶段读取合法 0.8，normalize 阶段读取非法非有限数。
 * 失败语义：直接进入 JSON.stringify 会把 Infinity 静默转成 null。
 * 断言目的：确认 Proxy 竞态只能得到稳定错误，不能生成半合法 Prompt。
 */
test('rejects request proxies that mutate threshold after validation', () => {
  let thresholdReads = 0;
  const request = new Proxy(requestFixture(), {
    get(target, property, receiver) {
      // 校验阶段的四次读取返回合法值，后续 normalize 读取返回 Infinity。
      if (property === 'threshold') {
        thresholdReads += 1;
        return thresholdReads <= 4 ? target.threshold : Number.POSITIVE_INFINITY;
      }
      return Reflect.get(target, property, receiver);
    }
  });
  let output: ReturnType<typeof buildIntentDecisionInput> | undefined;

  // 必须在 JSON 输出前失败，不能产生 threshold: null 的半合法 Prompt。
  // 输出变量保持 undefined，证明 builder 没有把污染后的结构交给模型。
  assertStableError(() => { output = buildIntentDecisionInput(request); }, 'Intent Decision request 无效：输入必须可 JSON 序列化');
  assert.equal(output, undefined);
});
