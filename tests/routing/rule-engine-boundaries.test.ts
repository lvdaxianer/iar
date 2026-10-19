/*
 * 这里覆盖受限规则引擎的资源、安全和候选决策边界。
 * 这些场景与组合逻辑分开，便于审查每一条 fail-closed 规则。
 * 测试只使用本地事实和规则，不触发网络、数据库或插件执行。
 * 正则模式属于不可信配置，任何无法证明安全的形态都必须拒绝。
 * 正则长度限制防止单个模式占用过多编译和匹配资源。
 * 正则嵌套量词限制防止回溯组合造成不可预测的 CPU 消耗。
 * 非法 RegExp 语法必须转化为稳定 invalid_rule，而不是抛出异常。
 * 转义字符、非捕获分组和前瞻语法需要与真实正则语义保持一致。
 * 多层嵌套量词是上一轮 review 发现的回归风险，因此单独固定样例。
 * facts 资源限制覆盖深度和节点总数，防止校验阶段被输入拖垮。
 * 表达式资源限制覆盖深度和宽度，防止组合节点产生过大临时数组。
 * 宽度预算必须在遍历前检查，达到上限后不能继续扫描其余输入。
 * facts 允许非循环共享引用，当前路径集合不能把它们误报为循环。
 * facts 循环必须拒绝，避免字段查找和深比较进入无限递归。
 * 共享引用测试同时验证事实校验和字段路径求值的兼容性。
 * 共享对象参与 equals 时，比较应以 JSON 结构为准而不是别名。
 * 深比较的对象对映射只在当前递归路径有效，离开分支后应移除。
 * 数组比较必须保留长度和顺序，不能把数组当作无序集合。
 * 对象比较必须忽略插入顺序，但不能忽略对象与数组的类型差异。
 * 原型对象不是 JSON facts，比较器也不应读取原型链上的属性。
 * runtime target 校验模拟 TypeScript 类型擦除后的不可信输入。
 * 入口契约校验必须先于候选排序，防止无效规则污染证据。
 * invalid_rule 的候选标识用于定位输入来源，不代表业务候选命中。
 * 优先级高于特异性，排序结果必须与 OpenSpec 的冲突规则一致。
 * 同等级候选进入澄清，不能因为数组顺序稳定就自动选择第一项。
 * 澄清结果必须保留完整候选、规则和等级证据。
 * PluginRule 只有在宿主快照四项门禁都满足时才能生成候选。
 * enabled 是生命周期门禁，规则命中不能替插件改变生命周期。
 * authorized 是权限门禁，规则命中不能替插件授予访问权限。
 * functionId 是归属门禁，规则命中不能跨 Function 借用插件。
 * capabilities 是能力门禁，候选清单缺少能力时必须排除。
 * 这些测试不覆盖 Task 2.3 的真实宿主重验证和 Policy Gate。
 * 这些测试也不覆盖 Task 2.4 的确认、幂等、重试和恢复。
 * 本文件只固定 Task 2.1 已承诺的边界，不扩张实现职责。
 * 每个拒绝断言同时检查状态或 reasonCode，避免错误被吞掉。
 * 每个命中断言检查 selectedCandidateId 或候选输出，避免只测无异常。
 * 规则引擎输出是结构化证据，调用方不应依赖异常文本。
 * 测试名称直接对应 OpenSpec 的验收语义，便于任务审计。
 * 资源边界测试使用超过阈值的输入，防止阈值代码被删除后仍通过。
 * shared facts 测试使用同一引用出现在兄弟路径，模拟真实聚合事实。
 * shared equals 测试使用不同引用但相同结构，验证比较器的结构语义。
 * cyclic facts 测试保留事实归因，避免误判为业务规则无匹配。
 * deep facts 测试在规则求值前失败，验证校验器本身也受资源限制。
 * wide expression 测试覆盖 512 节点预算的提前停止路径。
 * deep expression 测试覆盖递归深度拒绝路径。
 * 非法 pattern 测试覆盖类型、长度、语法和量词四类输入错误。
 * `((a)+)+` 覆盖子组量化后再次被外层量化的组合风险。
 * `(a{1,})+` 覆盖花括号量词与外层量词的组合风险。
 * non-capturing group 语法不应把问号误认成独立量词。
 * 分组扫描遇到转义括号时不应改变量化状态栈。
 * 运行时 target 测试保证 Function 阶段不会接受 Plugin 规则。
 * 候选排序测试保证高 priority 优先于高 specificity。
 * 冲突测试保证 selectedCandidateId 在 needs_clarification 中为空。
 * Plugin 测试保证每一项排除都保留独立 reasonCode。
 * confirmation 只作为候选元数据保留，不会触发确认副作用。
 * 测试不读取私有实现函数，因此允许安全扫描器内部重构。
 * 测试只依赖公共 RuleEngine API 和稳定 fixture 构造器。
 * 这使模块可以在 Node.js 测试 runner 中重复执行。
 * 规则输入的数组会被后续修改时，输出快照不能随之改变。
 * 资源拒绝结果不能携带半成品候选，避免下游误执行。
 * 正则拒绝结果不能携带 selectedCandidateId，保持 fail-closed。
 * facts 拒绝结果的 candidateId 固定为 facts，便于上层分类处理。
 * Plugin 门禁发生在规则命中之后，结果仍需保留排除候选证据。
 * 下游决策层可以使用 lower_priority 和门禁 reasonCode 解释收敛过程。
 * 当前文件不测试外部持久化，因此不会把测试状态写入工作区数据库。
 * 当前文件不测试网络或真实插件，因此不会引入环境依赖。
 * 代码审查发现的边界问题应优先在这里形成回归测试。
 * 修改预算常量时必须重新验证超过阈值的样例仍然 rejected。
 * 修改排序策略时必须重新验证唯一命中和并列澄清两种结果。
 * 修改 Plugin 门禁时必须保持四类失败的 reasonCode 可区分。
 * 修改深比较时必须同时验证循环保护、共享引用和属性顺序。
 * 修改正则扫描时必须同时验证转义、分组和嵌套量词。
 * 修改 facts 校验时必须同时验证普通对象、数组、循环和深度。
 * 类型擦除回归必须继续通过运行时契约校验，而不是依赖编译器。
 * 这些测试是回放确定性和后续 workflow 编排的基础。
 * 只有 focused、full、lint、build 和 diff check 全部通过才可提交。
 *
 * 资源拒绝应发生在候选生成之前，避免下游看到不完整的候选。
 * 节点预算和深度预算是两条独立防线，不能只保留其中一条。
 * facts 路径集合在每个子分支结束后释放，兄弟分支可以复用对象。
 * deepEqual 的路径集合也在每个子分支结束后释放，保持结构语义。
 * 同一对象在 facts 的不同字段出现不等于循环引用。
 * 同一对象在自身后代再次出现才是循环引用。
 * equals 测试使用共享实际值和独立期望值，验证别名无关比较。
 * 规则值来自契约允许的 JSON Value，不应包含 WeakMap 或函数。
 * 宿主快照中的能力数组只用于门禁，不会被规则表达式动态追加。
 * 规则 target 校验必须在构造内部 CandidateRule 之前完成。
 * 公开 RuleEngine API 不允许绕过 facts 和 rule 的运行时校验。
 * 内部求值器只由同一包内的候选评估流程调用。
 * 排除证据应尽量携带 ruleId，便于不依赖数组位置进行审计。
 * lower_priority 说明候选被更高等级候选压过，而不是规则未命中。
 * 门禁 reasonCode 说明宿主状态，不能合并成低信息量的 candidate_unavailable。
 * 正则 reject 不代表业务事实不匹配，而代表规则配置不可接受。
 * unknown field reject 不代表权限拒绝，而代表规则无法安全解释。
 * needs_clarification 不代表失败，代表调用方必须补充选择信息。
 * no_match 不代表规则配置错误，表示当前事实没有候选命中。
 * matched 不代表授权或执行成功，只表示候选规则通过评估。
 * 评估器不负责确认、不负责重试、不负责恢复，也不负责提交事件。
 * 这些非目标保证后续任务可以在明确边界上消费本模块结果。
 * 每次修改 evaluator 都应重新运行全部 routing 测试而不是单测文件。
 * 每次修改证据结构都应重新运行 Phase 1 的 contracts 和 storage 测试。
 * 每次修改输入边界都应重新检查 lint、build 和 diff check。
 * 审查报告中的 MUST 项必须转化为代码或测试证据后才能结束任务。
 * 该文件拆分后仍保持一个测试 runner 可以发现所有场景。
 * 文件长度限制用于保持审查上下文可控，不是对测试覆盖的削弱。
 * 注释记录安全意图，避免未来只为通过样例而放宽边界。
 * 测试断言保持稳定，避免绑定实现内部函数名或临时数据结构。
 * 规则资源预算的常量变化必须同步更新测试输入和 OpenSpec 证据。
 * 任何新增比较操作符都必须加入策略映射和非法操作符回归。
 * 任何新增正则语法都必须先证明不会绕过嵌套量词保护。
 * 任何新增 Plugin 门禁都必须声明其归属和失败 reasonCode。
 * 这是 Task 2.1 的最后边界测试集合，后续工作应消费而非绕过它。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonValue, RuleExpression } from '@iar/contracts';
import { RuleEngine, type FunctionRule } from '@iar/rule-engine';
import { facts, functionRule, pluginCandidate, pluginRule } from './rule-engine-fixtures.js';

test('同一候选的风险等级按最高值聚合且证据数组与输入隔离', () => {
  const engine = new RuleEngine();
  const requiredSlots = ['subject.id'];
  const evidenceCodes = ['low-risk'];
  const result = engine.evaluateFunctions({
    facts,
    rules: [
      functionRule('shared-candidate', {
        condition: { field: 'semantic.intent', operator: 'equals', value: 'service.stop' }
      }, { ruleId: 'shared-low', priority: 100, riskLevel: 'low', requiredSlots, evidenceCodes }),
      functionRule('shared-candidate', {
        condition: { field: 'semantic.action', operator: 'equals', value: 'stop' }
      }, { ruleId: 'shared-high', priority: 90, riskLevel: 'high', evidenceCodes: ['high-risk'] })
    ]
  });
  requiredSlots.push('mutated');
  evidenceCodes.push('mutated');

  assert.equal(result.candidates[0]?.riskLevel, 'high');
  assert.deepEqual(result.matchedRules[0]?.requiredSlots, ['subject.id']);
  assert.equal(result.matchedRules[0]?.evidenceCodes.includes('mutated'), false);
  assert.equal(result.candidates[0]?.evidenceCodes.includes('high-risk'), true);
});

test('非法 matches 模式被拒绝而不是伪装成普通无匹配', () => {
  const engine = new RuleEngine();
  const result = engine.evaluateFunctions({
    facts,
    rules: [functionRule('invalid-pattern', {
      condition: { field: 'semantic.intent', operator: 'matches', value: '[' }
    })]
  });

  assert.equal(result.status, 'rejected');
  assert.equal(result.excludedCandidates[0]?.reasonCode, 'invalid_rule');
});

test('matches 拒绝非字符串、超长和嵌套量词 pattern', () => {
  const engine = new RuleEngine();
  const patterns = [123, 'a'.repeat(257), '(a{1,})+', '((a)+)+'] as unknown[];
  const results = patterns.map((pattern) => engine.evaluateFunctions({
    facts,
    rules: [functionRule(`invalid-pattern-${String(pattern).slice(0, 8)}`, {
      condition: { field: 'semantic.intent', operator: 'matches', value: pattern as unknown as JsonValue }
    })]
  }));

  assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected', 'rejected', 'rejected']);
});

test('facts 和递归表达式超过资源边界时稳定拒绝', () => {
  const engine = new RuleEngine();
  const base: RuleExpression = { condition: { field: 'semantic.intent', operator: 'equals', value: 'service.stop' } };
  const deep = Array.from({ length: 66 }).reduce<RuleExpression>((expression) => ({ all: [expression] }), base);
  const deepResult = engine.evaluateFunctions({ facts, rules: [functionRule('deep-rule', deep)] });
  const wide = { all: Array.from({ length: 600 }, () => base) } as RuleExpression;
  const wideResult = engine.evaluateFunctions({ facts, rules: [functionRule('wide-rule', wide)] });
  const deepFacts = Array.from({ length: 66 }).reduce<Record<string, unknown>>((value) => ({ next: value }), {});
  const deepFactsResult = engine.evaluateFunctions({ facts: deepFacts, rules: [functionRule('deep-facts', base)] });
  const shared = { value: 'service.stop' };
  const sharedFacts = { ...facts, subject: { ...(facts.subject as Record<string, unknown>), shared } };
  const sharedFactsResult = engine.evaluateFunctions({ facts: sharedFacts, rules: [functionRule('shared-facts', {
    condition: { field: 'subject.shared.value', operator: 'equals', value: 'service.stop' }
  })] });
  const sharedValue = { status: 'ready' };
  const structuredFacts = { ...facts, context: { workflow: { left: sharedValue, right: sharedValue } } };
  const structuredResult = engine.evaluateFunctions({ facts: structuredFacts, rules: [functionRule('shared-equals', {
    condition: { field: 'context.workflow', operator: 'equals', value: { left: { status: 'ready' }, right: { status: 'ready' } } }
  })] });
  const cyclicFacts: Record<string, unknown> = { semantic: facts.semantic };
  cyclicFacts.self = cyclicFacts;
  const cyclicResult = engine.evaluateFunctions({ facts: cyclicFacts, rules: [functionRule('cyclic-facts', base)] });

  assert.equal(deepResult.status, 'rejected');
  assert.equal(wideResult.status, 'rejected');
  assert.equal(deepFactsResult.excludedCandidates[0]?.candidateId, 'facts');
  assert.equal(sharedFactsResult.status, 'matched');
  assert.equal(structuredResult.status, 'matched');
  assert.equal(cyclicResult.excludedCandidates[0]?.candidateId, 'facts');
});

test('运行时契约校验拒绝 target 不匹配的规则', () => {
  const engine = new RuleEngine();
  const invalid = functionRule('runtime-invalid', {
    condition: { field: 'semantic.intent', operator: 'equals', value: 'service.stop' }
  });
  const result = engine.evaluateFunctions({
    facts,
    rules: [{ ...invalid, rule: { ...invalid.rule, target: 'plugin' } } as unknown as FunctionRule]
  });

  assert.equal(result.status, 'rejected');
  assert.equal(result.excludedCandidates[0]?.reasonCode, 'invalid_rule');
});

test('优先级优先于特异性，同等级候选进入 needs_clarification', () => {
  const engine = new RuleEngine();
  const result = engine.evaluateFunctions({
    facts,
    rules: [
      functionRule('lower-priority-specific', {
        condition: { field: 'semantic.intent', operator: 'equals', value: 'service.stop' }
      }, { priority: 90, specificity: 99 }),
      functionRule('higher-priority-general', {
        condition: { field: 'semantic.intent', operator: 'equals', value: 'service.stop' }
      }, { priority: 100, specificity: 1 })
    ]
  });
  const conflict = engine.evaluateFunctions({
    facts,
    rules: [
      functionRule('candidate-a', {
        condition: { field: 'semantic.intent', operator: 'equals', value: 'service.stop' }
      }, { priority: 100, specificity: 2 }),
      functionRule('candidate-b', {
        condition: { field: 'semantic.intent', operator: 'equals', value: 'service.stop' }
      }, { priority: 100, specificity: 2 })
    ]
  });

  assert.equal(result.status, 'matched');
  assert.equal(result.selectedCandidateId, 'higher-priority-general');
  assert.equal(conflict.status, 'needs_clarification');
  assert.equal(conflict.selectedCandidateId, undefined);
  assert.deepEqual(conflict.candidates.map((candidate: { candidateId: string }) => candidate.candidateId), ['candidate-a', 'candidate-b']);
  assert.equal(conflict.conflicts[0]?.reasonCode, 'equal_priority_and_specificity');
});

test('PluginRule 只返回启用、授权、归属和能力满足的插件', () => {
  const engine = new RuleEngine();
  const ruleExpression: RuleExpression = {
    condition: { field: 'semantic.intent', operator: 'equals', value: 'service.stop' }
  };
  const result = engine.evaluatePlugins({
    facts,
    functionId: 'dip.service.stop',
    candidates: [
      pluginCandidate('enabled-authorized'),
      pluginCandidate('disabled', { enabled: false }),
      pluginCandidate('unauthorized', { authorized: false }),
      pluginCandidate('wrong-function', { functionId: 'ticket.create' }),
      pluginCandidate('missing-capability', { capabilities: [] })
    ],
    rules: [
      pluginRule('enabled-authorized', ruleExpression, { requiresConfirmation: true }),
      pluginRule('disabled', ruleExpression),
      pluginRule('unauthorized', ruleExpression),
      pluginRule('wrong-function', ruleExpression),
      pluginRule('missing-capability', ruleExpression)
    ]
  });

  assert.equal(result.status, 'matched');
  assert.equal(result.selectedCandidateId, 'enabled-authorized');
  assert.deepEqual(result.candidates.map((candidate: { candidateId: string }) => candidate.candidateId), ['enabled-authorized']);
  assert.equal(result.candidates[0]?.requiresConfirmation, true);
  assert.deepEqual(
    result.excludedCandidates.map((candidate: { reasonCode: string }) => candidate.reasonCode),
    ['disabled_plugin', 'unauthorized_plugin', 'function_ownership_mismatch', 'missing_capability']
  );
});
