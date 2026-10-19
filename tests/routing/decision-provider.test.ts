/*
 * 验证 Task 2.2 的 Mock DecisionProvider 和统一决策结果校验。
 * Provider 只接收有限候选和结构化约束，不接触真实模型或外部服务。
 * 原始 provider 输出视为不可信输入，必须再次经过公共 Decision Schema。
 * choice 只能引用输入候选，不能动态增加 capability 或候选标识。
 * candidateIds 是决策看到的有限集合，校验器不会接受额外候选。
 * score 必须是 0 到 1 的有限数，并满足当前请求的阈值。
 * 低于阈值不产生 choice，而是 needs_clarification。
 * 空候选没有可执行选择，统一返回 noul。
 * 最高 priority 和 specificity 并列时，统一返回 needs_clarification。
 * provider 的错误版本和错误 decisionType 不能伪装成成功选择。
 * provider 返回未知状态、错误字段或额外候选时必须 rejected。
 * rejected 和 noul 结果仍保留稳定 reasonCode 与完整候选集合。
 * 结果不包含授权结论，后续 runtime 必须重新验证 registry 和 policy。
 * 测试不验证真实模型质量，只验证边界、类型和确定性输出。
 * 每个拒绝场景检查 status 和 reasonCode，避免依赖异常文本。
 * 每个成功场景检查 choice、score、版本和 candidateIds。
 * 这些测试与 Task 2.1 的候选证据解耦，只使用最小候选投影。
 * 这使 DecisionProvider 可以被后续 Function/Plugin 两阶段编排复用。
 * 本文件不实现 Policy Gate、确认、Action 执行或恢复。
 * 后续任务消费这里的 needs_clarification，而不是绕过它。
 * provider factory 的输入断言用于证明候选集合保持有限且顺序稳定。
 * provider 不应修改调用方的候选数组，输出也必须是新对象。
 * 阈值拒绝是可解释结果，不是 provider 运行时异常。
 * 空候选处理在 provider 调用前完成，避免无意义的模型调用。
 * 并列处理在 provider 调用前完成，避免模型静默猜测。
 * 这些边界保证低置信度不会启动副作用工作流。
 * 错误 choice 只能导致 rejected，不能降级为其他候选的 choice。
 * 错误 candidateIds 只能导致 rejected，不能由校验器自动扩容集合。
 * 决策版本由请求约束固定，provider 不能返回另一个版本。
 * decisionType 由请求约束固定，Function 和 Plugin 不能混用。
 * 结构化输出错误统一映射 invalid_decision_output。
 * 规则候选的 priority/specificity 只用于判定可区分性。
 * 这些测试覆盖 choice、score、rejection、noul 四类结果路径。
 * 运行时契约校验是本任务的核心安全边界。
 * 通过 focused、full、lint、build 和 diff check 后才可提交。
 *
 * 有效 choice 测试固定决策结果的版本、阶段、分数和候选集合。
 * 低分测试固定阈值行为，确保低置信度不进入执行路径。
 * 空候选测试固定 noul 语义，并验证 provider 不会被无意义调用。
 * 并列测试固定 priority/specificity 同等级的澄清语义。
 * 这一层的并列保护不依赖 provider 是否聪明或稳定。
 * 越界 choice 测试模拟 provider 请求一个未由规则引擎产生的目标。
 * 校验器必须拒绝越界 choice，不能自动选择第一个候选。
 * 候选扩展测试模拟 provider 增加未授权的候选标识。
 * 校验器必须保留请求集合并返回 candidate_set_mismatch。
 * 版本测试防止旧 provider 输出被误用于新决策阶段。
 * 类型测试防止 Function 和 Plugin 决策结果交叉使用。
 * malformed output 测试证明 Schema 校验失败会结构化拒绝。
 * explicit rejection 测试证明 provider 可以表达业务拒绝。
 * explicit noul 测试证明 provider 可以表达没有可执行选择。
 * invalid candidate 测试覆盖 NaN priority 这种不可排序输入。
 * invalid candidate 测试也证明 provider 在请求不可信时不会被调用。
 * 候选输入使用 readonly 类型，测试不会修改共享 fixture。
 * provider 工厂返回 unknown，刻意模拟类型擦除后的外部响应。
 * validChoice 只构造测试输出，不代表真实模型协议已经存在。
 * 每个结果都由统一校验器生成或规范化。
 * 结果中的 candidateIds 由请求集合约束，而不是由 provider 自由决定。
 * 结果中的 choice 只有 status=choice 且通过阈值时才保留。
 * needs_clarification 永远不应携带可执行 choice。
 * noul 永远不应携带可执行 choice。
 * rejected 的 reasonCode 用于上层审计和回放，不依赖异常文本。
 * provider 不被调用的断言是副作用边界的一部分。
 * 本地 Mock 不访问网络、不读数据库、不启动插件。
 * 决策结果不会改变 RuleCandidateEvidence 或 BehaviorContext。
 * 运行时仍需在后续 Task 2.3 重验 tenant、environment、actor 和能力。
 * Policy Gate 仍需在后续 Task 2.4 决定动作是否允许执行。
 * 低分澄清和并列澄清都必须停留在决策层。
 * 空候选 noul 与 provider 主动 noul 都需要稳定 reasonCode。
 * provider 主动 rejected 的 reasonCode 由 provider 提供但仍经过 Schema。
 * malformed output 的 reasonCode 由本地校验器生成。
 * choice_not_in_candidates 的 reasonCode 由本地边界生成。
 * invalid_score 的 reasonCode 由本地分数校验生成。
 * invalid_decision_request 的 reasonCode 由本地输入校验生成。
 * candidate_set_mismatch 的 reasonCode 由候选集合校验生成。
 * 测试名称保持业务语言，失败时可映射到 OpenSpec Task 2.2。
 * 测试数据不依赖时间、随机数或环境变量。
 * 测试顺序不应改变 provider 的输出或候选集合。
 * 这些断言为后续真实 ModelGateway 提供可复用的安全外壳。
 * 真实 Provider 只能替换 responseFactory，不应绕过 validateDecisionOutput。
 * 决策模块只接受有限候选，不接受任意自然语言选择目标。
 * candidateId 是 opaque 标识，不能通过字符串格式推断权限。
 * priority 和 specificity 只用于可区分性，不等于授权等级。
 * score 只用于置信度阈值，不等于 Policy approval。
 * reasonCode 只描述决策结果，不授予 capability。
 * decisionVersion 只描述 provider 语义，不改变规则版本。
 * 这套测试不锁定具体 provider 实现细节。
 * 这套测试锁定的是统一结果契约和安全边界。
 * 修改 DecisionResult Schema 时必须同步更新这些场景。
 * 修改阈值语义时必须保留低分无 choice 回归。
 * 修改候选排序时必须保留并列澄清回归。
 * 修改 provider 调用时必须保留空候选和并列不调用回归。
 * 修改 reasonCode 时必须同步更新审计文档和上层消费方。
 * 修改候选投影时必须确认不会携带敏感 facts。
 * 修改错误处理时必须保持异常不泄漏到公共 API。
 * 修改版本策略时必须继续拒绝阶段或版本错配输出。
 * 新增状态时必须说明 choice、score 和 candidateIds 的兼容语义。
 * 新增输入约束时必须增加非法输入测试和稳定原因码。
 * 该测试文件是 Task 2.2 的行为合同，不是模型质量评测。
 * 全量通过后才能把 Task 2.2 标记为完成。
 *
 * malformed request 回归保证公开校验函数也能处理类型擦除输入。
 * malformed candidate 回归保证可选数组和枚举字段不会污染 provider。
 * nested snapshot 回归保证 provider 不能修改调用方的槽位数组。
 * 这些回归共同保证 DecisionProvider 是纯边界组件。
 * 输入快照隔离也为未来异步 provider 保留安全前提。
 * 即使 provider 代码尝试修改快照，原始候选仍保持不变。
 * 任何新的候选元数据都必须加入 allowedKeys 和对应类型校验。
 * 任何新的决策状态都必须明确是否允许 choice 和 score。
 * 任何新的 provider 实现都必须复用统一校验入口。
 * 任何新的阈值策略都必须保留低分澄清断言。
 * 所有校验失败都应返回可序列化的 DecisionResult。
 * 本地结果可以安全写入后续 EventLog 或 replay fixture。
 * 这里不把 provider 异常直接暴露给上层调用方。
 * 这里不把候选事实全文复制到决策输出，避免信息扩散。
 * 候选元数据只用于解释和排序，不等于最终授权。
 * 测试覆盖的是防御性协议，不是 provider 的随机性。
 * 结果稳定性比 provider 的具体实现更重要。
 * 该文件的分支说明与代码审查规范保持一致。
 * 文件保持在审查允许的长度范围内，避免测试上下文失控。
 * focused 测试先验证本模块，再由 full 测试验证跨包兼容。
 * OpenSpec 计划文件记录边界，审计文件记录最终证据。
 * 任务完成后再把 checklist 从 [ ] 更新为 [x]。
 * 这条顺序确保失败测试不会被误记为完成。
 * 本模块完成后由 Task 2.3 消费其受控结果。
 *
 * 测试注释与实现注释共同描述输入、输出和副作用边界。
 * 这里的候选数量始终有限，避免把测试变成开放式搜索。
 * 这里的结果始终可序列化，便于后续 replay 断言。
 * 这里的失败原因始终稳定，便于上层分支处理。
 * 这里的 provider 调用始终可替换为确定性工厂。
 * 这里的快照始终与调用方数组隔离。
 * 这里的分数始终受闭区间和阈值约束。
 * 这里的选择始终受 candidateId 集合约束。
 * 这里的版本始终受请求 decisionVersion 约束。
 * 这些补充说明固定本任务的测试意图。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSIONS } from '@iar/contracts';
import { MockDecisionProvider, validateDecisionOutput, type DecisionCandidate, type DecisionRequest } from '@iar/decision';

const candidates: readonly DecisionCandidate[] = [
  { candidateId: 'dip.service.stop', priority: 100, specificity: 2 },
  { candidateId: 'ticket.create', priority: 90, specificity: 4 }
];

const request: DecisionRequest = {
  decisionType: 'function.select',
  decisionVersion: 'mock.v1',
  threshold: 0.7,
  candidates
};

function provider(response: unknown): MockDecisionProvider {
  return new MockDecisionProvider(() => response);
}

function validChoice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSIONS.decision,
    decisionType: request.decisionType,
    decisionVersion: request.decisionVersion,
    status: 'choice',
    choice: 'dip.service.stop',
    score: 0.91,
    reasonCode: 'mock.choice',
    candidateIds: candidates.map((candidate) => candidate.candidateId),
    ...overrides
  };
}

test('valid choice is accepted only from the finite candidate set', () => {
  const result = provider(validChoice()).decide(request);

  assert.equal(result.status, 'choice');
  assert.equal(result.choice, 'dip.service.stop');
  assert.equal(result.score, 0.91);
  assert.deepEqual(result.candidateIds, ['dip.service.stop', 'ticket.create']);
  assert.equal(result.decisionVersion, 'mock.v1');
});

test('score below threshold returns clarification without an executable choice', () => {
  const result = provider(validChoice({ score: 0.69 })).decide(request);

  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.choice, undefined);
  assert.equal(result.reasonCode, 'score_below_threshold');
});

test('empty candidates return noul before invoking the provider response', () => {
  let invoked = false;
  const mock = new MockDecisionProvider(() => {
    invoked = true;
    return validChoice();
  });
  const result = mock.decide({ ...request, candidates: [] });

  assert.equal(result.status, 'noul');
  assert.equal(result.choice, undefined);
  assert.equal(result.reasonCode, 'candidate_empty');
  assert.equal(invoked, false);
});

test('indistinguishable top candidates return clarification before provider selection', () => {
  let invoked = false;
  const mock = new MockDecisionProvider(() => {
    invoked = true;
    return validChoice();
  });
  const result = mock.decide({
    ...request,
    candidates: candidates.map((candidate) => ({ ...candidate, priority: 100, specificity: 2 }))
  });

  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.reasonCode, 'indistinguishable_candidates');
  assert.equal(invoked, false);
});

test('choice outside candidates is rejected and cannot be remapped', () => {
  const result = provider(validChoice({ choice: 'unauthorized.plugin' })).decide(request);

  assert.equal(result.status, 'rejected');
  assert.equal(result.choice, undefined);
  assert.equal(result.reasonCode, 'choice_not_in_candidates');
});

test('provider cannot add candidate ids to the constrained set', () => {
  const result = provider(validChoice({ candidateIds: ['dip.service.stop', 'unauthorized.plugin'] })).decide(request);

  assert.equal(result.status, 'rejected');
  assert.equal(result.reasonCode, 'candidate_set_mismatch');
  assert.deepEqual(result.candidateIds, ['dip.service.stop', 'ticket.create']);
});

test('wrong decision version or type is rejected as invalid output', () => {
  const wrongVersion = provider(validChoice({ decisionVersion: 'other.v1' })).decide(request);
  const wrongType = provider(validChoice({ decisionType: 'plugin.select' })).decide(request);

  assert.equal(wrongVersion.status, 'rejected');
  assert.equal(wrongVersion.reasonCode, 'invalid_decision_output');
  assert.equal(wrongType.status, 'rejected');
  assert.equal(wrongType.reasonCode, 'invalid_decision_output');
});

test('malformed provider output is converted into a stable rejection', () => {
  const result = provider({ status: 'choice', choice: 'dip.service.stop' }).decide(request);

  assert.equal(result.status, 'rejected');
  assert.equal(result.reasonCode, 'invalid_decision_output');
  assert.deepEqual(result.candidateIds, ['dip.service.stop', 'ticket.create']);
});

test('invalid candidate priority or specificity is rejected before provider invocation', () => {
  let invoked = false;
  const mock = new MockDecisionProvider(() => {
    invoked = true;
    return validChoice();
  });
  const malformed = {
    ...request,
    candidates: [{ candidateId: 'bad', priority: Number.NaN, specificity: 1 }]
  } as unknown as DecisionRequest;
  const result = mock.decide(malformed);

  assert.equal(result.status, 'rejected');
  assert.equal(result.reasonCode, 'invalid_decision_request');
  assert.equal(invoked, false);
});

test('malformed request returns a stable rejection instead of throwing', () => {
  const result = validateDecisionOutput(null as unknown as DecisionRequest, null);

  assert.equal(result.status, 'rejected');
  assert.equal(result.reasonCode, 'invalid_decision_request');
  assert.equal(result.decisionType, 'function.select');
});

test('malformed optional candidate fields are rejected before provider invocation', () => {
  let invoked = false;
  const mock = new MockDecisionProvider(() => {
    invoked = true;
    return validChoice();
  });
  const malformed = {
    ...request,
    candidates: [{ candidateId: 'bad', priority: 1, specificity: 1, requiredSlots: 123, extra: true }]
  } as unknown as DecisionRequest;
  const result = mock.decide(malformed);

  assert.equal(result.status, 'rejected');
  assert.equal(result.reasonCode, 'invalid_decision_request');
  assert.equal(invoked, false);
});

test('provider receives an isolated nested candidate snapshot', () => {
  const requiredSlots = ['subject.id'];
  const isolatedRequest = { ...request, candidates: [{ candidateId: 'dip.service.stop', priority: 100, specificity: 2, requiredSlots }] };
  const mock = new MockDecisionProvider((snapshot) => {
    const slots = snapshot.candidates[0]?.requiredSlots as string[];
    slots.push('mutated');
    return validChoice();
  });
  mock.decide(isolatedRequest);

  assert.deepEqual(requiredSlots, ['subject.id']);
});

test('provider exception returns provider_failed with diagnostic context retained on Mock', () => {
  const failure = new Error('mock provider unavailable');
  const mock = new MockDecisionProvider(() => {
    throw failure;
  });
  const result = mock.decide(request);

  assert.equal(result.status, 'rejected');
  assert.equal(result.reasonCode, 'provider_failed');
  assert.equal(mock.lastError, failure);
});

test('explicit rejection and noul outputs remain typed and auditable', () => {
  const rejected = provider(validChoice({ status: 'rejected', choice: undefined, score: undefined, reasonCode: 'provider.rejected' })).decide(request);
  const noul = provider(validChoice({ status: 'noul', choice: undefined, score: undefined, reasonCode: 'provider.noul' })).decide(request);

  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reasonCode, 'provider.rejected');
  assert.equal(noul.status, 'noul');
  assert.equal(noul.reasonCode, 'provider.noul');
});
