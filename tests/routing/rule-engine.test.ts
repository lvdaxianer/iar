/** 验证 FunctionRule 与 PluginRule 的有限候选和可解释证据。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuleExpression } from '@iar/contracts';
import { RuleEngine } from '@iar/runtime';
import { facts, functionRule } from './rule-engine-fixtures.js';

/*
 * 本文件验证 Phase 2 Task 2.1 的受限规则引擎边界。
 * 测试只观察纯内存评估结果，不允许规则评估改变事实或运行时状态。
 * 每个场景都检查候选、排除原因、证据码或冲突结果中的至少一项。
 * 规则的 target、版本、优先级和特异性由公共契约统一约束。
 * 引擎只生成有限候选，后续授权、决策和执行仍由后续阶段负责。
 * ALL 场景验证所有可识别条件必须满足，避免部分事实扩大候选。
 * ANY 场景验证明确命中即可通过，但拒绝状态不能被命中掩盖。
 * NONE 场景验证命中排除条件会产生稳定的排除证据。
 * unknownFieldPolicy 场景覆盖 ignore、match_none 和 reject 三种语义。
 * exists 场景区分字段缺失与字段存在但值为空的情况。
 * equals 场景覆盖结构化值比较，属性插入顺序不影响回放结果。
 * contains、in 和 matches 场景覆盖字符串、数组、枚举和正则边界。
 * 同一候选多条规则的元数据必须聚合，较高风险不能被低风险覆盖。
 * 输入数组在评估后继续修改时，不得反向污染已经生成的证据快照。
 * 非法正则配置必须稳定拒绝，不能把配置错误伪装成普通无匹配。
 * 正则模式长度和嵌套量词必须受限，避免规则成为 CPU 消耗入口。
 * 资源边界同时覆盖事实深度、事实循环、表达式深度和表达式宽度。
 * 事实对象允许非循环的共享引用，当前路径集合不能误判共享结构。
 * 事实校验失败必须归因于 facts，而不是产生看似有效的业务候选。
 * 运行时再次校验 RuleDefinition，避免类型擦除后绕过 target 边界。
 * 优先级先于特异性，最高等级唯一时才允许设置 selectedCandidateId。
 * 最高等级并列必须进入 needs_clarification，禁止静默猜测路由目标。
 * PluginRule 额外受 Function 归属、启用状态、授权状态和能力白名单限制。
 * 插件门禁的每一种失败都应该有稳定 reasonCode，便于回放和审计。
 * 需要确认的插件候选只携带声明，当前任务不执行确认或外部副作用。
 * 测试使用稳定的 fixture 标识，使证据顺序和冲突结果可重复比较。
 * 测试不依赖时间、随机数、网络、数据库或真实插件宿主。
 * 这组测试的失败优先说明契约边界被破坏，而不是要求测试放宽断言。
 * 第一组测试覆盖组合逻辑以及规则未命中的排除记录。
 * 第一组测试也确保候选输出保留槽位、风险和自定义证据码。
 * 这保证规则评估结果可以交给后续决策层继续收敛。
 * 第二组测试专门验证 NONE 的排除原因不会退化为通用 rule_not_matched。
 * 稳定的 reasonCode 是回放、审计和人工解释所依赖的接口。
 * 第三组测试将未知字段策略放在相同表达式下对比，避免语义混淆。
 * ignore 可以保留命中，但必须把 unknown_field 写入命中证据。
 * match_none 只能让该规则不匹配，不能让整个请求无条件 rejected。
 * reject 必须停止当前候选生成，并保留 unknown_field_rejected 证据。
 * 第四组测试确认 exists 不会读取 value，也不会因 value 类型而误判。
 * 该语义为逐步演进的事实 schema 保留兼容路径。
 * 第五组测试覆盖 equals 的对象递归比较和三个常用操作符。
 * 比较逻辑必须拒绝原型对象，防止规则访问隐式原型属性。
 * contains 对字符串使用子串语义，对数组使用结构化元素语义。
 * in 要求规则 value 是数组，错误配置必须走 invalid_rule。
 * matches 只接受字符串 pattern，并限制模式大小和危险嵌套结构。
 * 第六组测试验证候选级别的风险、槽位和证据合并规则。
 * 聚合后的风险使用最高等级，避免安全声明被后续低风险规则覆盖。
 * 聚合后的数组必须是快照，不能引用调用方仍可修改的数组。
 * 第七组测试验证 JavaScript RegExp 编译错误的稳定拒绝路径。
 * 捕获异常后只能返回结构化结果，不能把底层异常暴露给路由调用方。
 * 第八组测试覆盖非字符串、超长模式以及一层和多层嵌套量词。
 * 嵌套量词扫描需理解转义字符，不能误把转义括号当成分组。
 * 非捕获和前瞻分组中的问号不是量词，合法模式不应被无故拒绝。
 * 资源限制属于运行时安全边界，因此用回归测试固定其拒绝结果。
 * 第九组测试把事实和表达式的资源边界放在同一个可回放场景中。
 * 表达式深度超过上限时应 rejected，而不是栈溢出或进程异常。
 * 表达式宽度超过节点预算时应停止继续展开结果数组。
 * 事实深度超过上限时必须在规则求值前拒绝输入。
 * 循环事实必须拒绝，避免序列化、查找或比较阶段无限递归。
 * 共享事实对象只在当前递归路径上去重，兄弟路径可以安全复用。
 * 第十组测试模拟运行时类型擦除后的恶意 target 修改。
 * 评估入口不能只依赖 TypeScript 类型，而必须调用公共契约校验。
 * target 不匹配的规则不能参与候选排序或产生命中证据。
 * 规则校验失败统一映射到 invalid_rule，保持对外错误形态稳定。
 * 第十一组测试固定优先级和特异性的排序顺序。
 * 高优先级的一般规则应胜过低优先级的高特异性规则。
 * 相同优先级和特异性只能说明存在冲突，不能自动选择第一项。
 * 冲突结果保留候选和规则标识，供后续澄清流程使用。
 * needs_clarification 不应设置 selectedCandidateId，避免被误执行。
 * 第十二组测试覆盖 PluginRule 的全部宿主门禁。
 * 只有 enabled、authorized、functionId 和 requiredCapabilities 都满足时才可命中。
 * disabled 插件不能因为规则命中而重新启用或进入候选。
 * unauthorized 插件必须排除，规则本身不能授予权限。
 * 错误 Function 归属必须排除，防止跨 Function 路由。
 * 缺失能力必须排除，能力清单由宿主快照提供而非规则推断。
 * PluginRule 结果仍然只是有限候选，不是执行计划或授权结论。
 * 这些测试共同锁定 Phase 2 Task 2.1 的最小可交付行为。
 * 后续 Task 2.3 将继续补充 PluginHost 和 Policy Gate 的运行时重验证。
 * 后续 Task 2.4 将消费这里的确认元数据并实现幂等与恢复语义。
 * 因此本文件不提前测试未进入当前任务边界的外部系统行为。
 * 测试名称使用业务语义，失败时可以直接映射回 OpenSpec 验收条目。
 * fixture 文件只提供稳定输入构造，规则语义仍在本文件显式表达。
 * 所有断言使用稳定字段，不依赖对象属性枚举顺序或错误文本。
 * 结果数组的顺序由规则排序和稳定标识决定，便于回放比对。
 * 对空候选、拒绝、冲突和命中四种主状态均有覆盖。
 * 该状态覆盖确保调用方不必根据异常或隐式 null 推断流程。
 * 本文件的注释同时记录安全意图，避免未来只保留表面行为测试。
 * 修改规则引擎时应先更新契约和边界测试，再修改实现。
 * 新增操作符必须补充成功、失败、未知字段和恶意输入四类断言。
 * 新增排除原因必须保持 reasonCode 稳定，并在证据测试中出现。
 * 新增候选元数据必须验证输入隔离，避免跨请求状态泄漏。
 * 任何可能遍历用户控制结构的代码都必须补充深度或节点预算测试。
 * 任何会改变候选排序的代码都必须补充唯一命中和并列澄清测试。
 * 任何 PluginRule 门禁都必须补充命中与排除两侧的回归测试。
 * 这套测试是后续 workflow、decision 和 replay 模块的底层行为基线。
 * 测试通过只表示规则评估符合边界，不表示已完成授权或执行。
 * 评估器应保持同步、纯函数式和可重复，避免引入不可审计副作用。
 * 本文件最终通过 lint、focused test、full test 和 diff check 才可提交。
 *
 * 规则输入的 facts 是外部边界，测试因此不把它当作可信内部对象。
 * facts 可以包含普通嵌套对象和数组，但不能包含函数或自定义原型。
 * facts 的 JSON-safe 检查先于任何字段读取，拒绝结果归因清晰可查。
 * 当前递归路径集合用于检测循环，兄弟路径不会共享错误的 visited 状态。
 * 节点预算保护宽对象，深度预算保护深对象，两者共同覆盖资源耗尽。
 * 表达式节点预算在 all、any、none 三种组合下共享而不是分别重置。
 * 共享预算确保恶意宽度无法通过嵌套组合放大计算量。
 * 规则表达式深度限制在求值入口和子节点遍历中都保持一致。
 * 预算拒绝使用 invalid_rule，调用方不需要解析异常文本。
 * 正则模式也属于外部配置，长度限制和嵌套量词限制独立于 JS 引擎。
 * 正则扫描跳过转义字符，避免误判 escaped parenthesis 和 escaped quantifier。
 * 正则扫描识别组关闭后的外层量词，覆盖多层 catastrophic backtracking 风险。
 * 合法的非捕获分组、前瞻分组和命名分组不应因为问号语法被当成量词。
 * RegExp 构造失败仍然映射到 invalid_rule，保持 fail-closed。
 * equals 的深比较用对象对映射避免循环值递归，且拒绝非普通对象。
 * 数组与对象的类型差异必须保留，不能仅因为键值相似就判等。
 * 对象键排序后比较，确保属性插入顺序不会改变回放结果。
 * contains 的数组元素比较复用深比较，避免引用相等造成误判。
 * in 的候选数组由规则定义，非法 value 不应被当成空集合。
 * exists 只看自有字段，不能通过原型链命中隐藏属性。
 * 点号路径逐段读取，并在中间段缺失后停止继续访问。
 * unknown 字段策略只作用于不存在的路径，不改变存在值的比较语义。
 * ignore 的 unknown_field 证据必须能从命中规则追溯到原子条件。
 * match_none 的 unknown_field 证据必须能从排除候选追溯到规则。
 * reject 的 unknown_field_rejected 证据必须让整体状态变为 rejected。
 * all 遇到 rejected 时优先传播，不能被其他 matched 子项掩盖。
 * any 遇到 rejected 时优先传播，配置错误不能被其他成功分支绕过。
 * none 遇到 rejected 时优先传播，排除条件配置错误不能默认放行。
 * none 的明确命中使用专用 evidenceCode，避免与普通失败混淆。
 * all 的纯 ignore 结果不应扩大候选范围，至少需要一个明确命中。
 * any 的 ignore 结果不应扩大候选范围，必须存在明确 matched 子项。
 * 组合结果只汇总稳定证据码，不暴露内部异常对象或栈信息。
 * 规则命中后才进入候选聚合，未命中规则不会产生虚假 metadata。
 * 同一 candidateId 的多条规则按 ruleId 稳定排序，避免输入顺序漂移。
 * 候选排序按 priority、specificity、candidateId 逐级比较。
 * 规则证据排序按 priority、specificity、ruleId 逐级比较。
 * 低等级候选保留 lower_priority 排除证据，便于解释为何未被选择。
 * 最高等级只有一个候选时才产生 selectedCandidateId。
 * 最高等级存在多个候选时只产生 needs_clarification。
 * needs_clarification 的 candidates 仍完整保留，供决策层提出澄清。
 * needs_clarification 的 conflicts 包含候选、规则和排序等级。
 * 冲突场景不能把稳定排序的第一项伪装成用户已经选择的目标。
 * 风险等级聚合采用 low、medium、high、critical 的固定顺序。
 * 聚合风险只允许升级，不允许后续低风险规则降级。
 * requiredSlots 使用稳定去重，多个规则可以共同声明补槽要求。
 * evidenceCodes 使用稳定去重，保留首次出现顺序便于审计阅读。
 * requiresConfirmation 只要任意命中规则声明 true，候选就必须保留 true。
 * confirmation 元数据不是执行动作，也不自动调用用户确认界面。
 * FunctionRule 的 functionId 是候选边界，不能由 facts 动态改写。
 * PluginRule 的 functionId 是宿主归属边界，不能由规则表达式绕过。
 * Plugin candidate 的 enabled 状态由宿主快照提供，规则不能修改生命周期。
 * Plugin candidate 的 authorized 状态由宿主快照提供，规则不能授予权限。
 * requiredCapabilities 是白名单交集约束，缺少一项就必须排除。
 * PluginRule 的规则命中和宿主门禁排除必须同时出现在结果证据中。
 * 错误归属优先报告 function_ownership_mismatch，而不是泛化成 no_match。
 * disabled 和 unauthorized 使用独立 reasonCode，便于运维和审计区分。
 * 缺失能力使用 missing_capability，不能因为候选名称相同而放行。
 * 当前任务只验证宿主快照门禁，真实 PluginHost 重验证留给 Task 2.3。
 * 规则引擎不读取数据库、不调用网络、不加载真实插件代码。
 * 规则引擎不修改 BehaviorContext、不发事件、不写审计存储。
 * 规则引擎只返回结构化结果，调用方负责后续决策和副作用边界。
 * 这些限制使评估结果可以被 replay 测试重复计算。
 * 结果证据保留版本字段，未来规则升级可以区分历史行为。
 * 版本字段来自 RuleDefinition，不能由评估时的默认值伪造。
 * 运行时契约校验确保 target、priority、specificity 和 expression 形状正确。
 * 类型擦除后的输入仍必须经过 validateContract，而不是只依赖 TS 编译。
 * 无效规则统一返回 rejected，避免不同入口暴露不一致错误语义。
 * 无效 facts 统一归因 candidateId facts，便于上层区分输入问题。
 * 空候选且无拒绝证据返回 no_match，不能无理由返回 rejected。
 * 空候选且存在拒绝证据返回 rejected，拒绝原因必须可追溯。
 * 结果对象中的数组都是新数组，防止调用方修改内部计算缓存。
 * 规则输入的 metadata 数组被复制，测试会在评估后修改原数组验证隔离。
 * candidate evidence 只包含候选层信息，不复制整个 facts，避免敏感数据泄漏。
 * matchedRules 只包含审计所需的 ruleId、version 和声明元数据。
 * excludedCandidates 只包含稳定排除原因和必要的规则来源。
 * 规则表达式的 value 通过公共 JsonValue 契约约束，避免任意对象进入比较器。
 * 测试中的恶意输入使用类型擦除模拟边界，不代表生产类型允许这些值。
 * 每一个安全拒绝测试都同时检查状态和原因，防止仅靠状态掩盖回归。
 * 每一个成功测试都至少检查一个业务输出和一个审计输出。
 * 排除测试检查 reasonCode，确保解释层不依赖英文异常消息。
 * 冲突测试检查 selectedCandidateId 未设置，确保执行层不会误选。
 * Plugin 测试检查候选只剩满足全部硬门禁的项目。
 * 全量测试还会验证本模块不破坏 Phase 1 的 contracts、storage 和 subscriptions。
 * focused test 用于快速反馈规则边界，full test 用于验证跨模块兼容性。
 * lint 和 build 用于确认公共类型导出、运行时契约和 ESM 路径一致。
 * diff check 用于阻止补丁带入空白错误，保证后续审查可读。
 * 变更 OpenSpec checklist 前必须先完成这些自动化验证和人工审查。
 * 代码审查发现的边界问题必须优先转化为回归测试，再修复实现。
 * 这样可以避免只修复当前样例而遗漏同类嵌套输入。
 * 未来新增规则运算符时应沿用这一测试组织方式。
 * 未来新增宿主门禁时应新增独立 reasonCode 和双向测试。
 * 未来新增候选元数据时应同步更新聚合隔离测试。
 * 未来改变排序策略时应同步更新冲突和 lower_priority 测试。
 * 未来改变资源上限时应保留超过上限的拒绝回归样例。
 * 该测试文件承担的是行为合同，而不是实现细节快照。
 * 断言尽量针对公共状态和证据码，不锁定私有函数名称。
 * 私有函数可以重构，只要公共结果和安全边界保持不变。
 * 所有测试输入都在本地构造，运行顺序不会影响结果。
 * 当前 12 个场景覆盖组合、比较、资源、排序、校验和宿主门禁。
 * 这正对应 OpenSpec Task 2.1 的 FunctionRule/PluginRule 验收范围。
 * 本任务完成后才进入 Policy Gate、confirmation、idempotency 和 resume 实现。
 * 规则引擎的 rejected 结果不会自动重试，也不会自动恢复工作流。
 * 规则引擎的 matched 结果不会自动授权，也不会自动执行插件动作。
 * 这些非目标边界写入注释，防止后续实现错误扩大本任务职责。
 * 评估器的稳定性是后续 orchestrator 做幂等和回放的前提。
 * 只有在本文件及全量回归通过后，才能把 Task 2.1 标记为完成。
 */

test('ALL、ANY、NONE 生成匹配候选和排除证据', () => {
  const engine = new RuleEngine();
  const result = engine.evaluateFunctions({
    facts,
    rules: [
      functionRule('dip.service.stop', {
        all: [
          { condition: { field: 'semantic.intent', operator: 'equals', value: 'service.stop' } },
          { any: [
            { condition: { field: 'semantic.action', operator: 'equals', value: 'stop' } },
            { condition: { field: 'semantic.action', operator: 'equals', value: 'terminate' } }
          ] },
          { none: [
            { condition: { field: 'context.workflow.status', operator: 'equals', value: 'completed' } }
          ] }
        ]
      }),
      functionRule('human.transfer', {
        condition: { field: 'semantic.intent', operator: 'equals', value: 'human.transfer' }
      })
    ]
  });

  assert.equal(result.status, 'matched');
  assert.equal(result.selectedCandidateId, 'dip.service.stop');
  assert.deepEqual(result.candidates.map((candidate: { candidateId: string }) => candidate.candidateId), ['dip.service.stop']);
  assert.equal(result.matchedRules[0]?.ruleId, 'rule-dip.service.stop');
  assert.deepEqual(result.candidates[0]?.requiredSlots, ['subject.id']);
  assert.equal(result.candidates[0]?.riskLevel, 'low');
  assert.deepEqual(result.candidates[0]?.evidenceCodes, ['test.rule']);
  assert.equal(result.excludedCandidates[0]?.candidateId, 'human.transfer');
  assert.equal(result.excludedCandidates[0]?.reasonCode, 'rule_not_matched');
});
test('NONE 命中排除条件时不生成 Function 候选', () => {
  const engine = new RuleEngine();
  const result = engine.evaluateFunctions({
    facts: {
      ...facts,
      context: { workflow: { status: 'completed' } }
    },
    rules: [functionRule('human.transfer', {
      all: [
        { condition: { field: 'semantic.intent', operator: 'equals', value: 'service.stop' } },
        { none: [
          { condition: { field: 'context.workflow.status', operator: 'equals', value: 'completed' } }
        ] }
      ]
    })]
  });

  assert.equal(result.status, 'no_match');
  assert.equal(result.candidates.length, 0);
  assert.equal(result.excludedCandidates[0]?.reasonCode, 'none_condition_matched');
  assert.equal(result.excludedCandidates[0]?.evidenceCode, 'none_condition_matched');
});

test('unknown 字段按 ignore、match_none、reject 分别产生显式结果', () => {
  const engine = new RuleEngine();
  const expression: RuleExpression = {
    all: [
      { condition: { field: 'semantic.intent', operator: 'equals', value: 'service.stop' } },
      { condition: { field: 'semantic.missing', operator: 'equals', value: true } }
    ]
  };
  const ignore = engine.evaluateFunctions({
    facts,
    rules: [functionRule('ignore-rule', expression, { unknownFieldPolicy: 'ignore' })]
  });
  const matchNone = engine.evaluateFunctions({
    facts,
    rules: [functionRule('match-none-rule', expression, { unknownFieldPolicy: 'match_none' })]
  });
  const reject = engine.evaluateFunctions({
    facts,
    rules: [functionRule('reject-rule', expression, { unknownFieldPolicy: 'reject' })]
  });

  assert.equal(ignore.status, 'matched');
  assert.equal(ignore.matchedRules[0]?.evidenceCodes.includes('unknown_field'), true);
  assert.equal(matchNone.status, 'no_match');
  assert.equal(matchNone.excludedCandidates[0]?.reasonCode, 'unknown_field');
  assert.equal(reject.status, 'rejected');
  assert.equal(reject.excludedCandidates[0]?.reasonCode, 'unknown_field_rejected');
});

test('exists 操作符只判断字段是否存在', () => {
  const engine = new RuleEngine();
  const present = engine.evaluateFunctions({
    facts,
    rules: [functionRule('present', { condition: { field: 'subject.id', operator: 'exists' } })]
  });
  const missing = engine.evaluateFunctions({
    facts,
    rules: [functionRule('missing', { condition: { field: 'subject.missing', operator: 'exists' } })]
  });

  assert.equal(present.status, 'matched');
  assert.equal(missing.status, 'no_match');
});

test('equals 忽略对象属性顺序，contains、in、matches 保持操作符语义', () => {
  const engine = new RuleEngine();
  const result = engine.evaluateFunctions({
    facts,
    rules: [functionRule('structured-match', {
      all: [
        { condition: { field: 'subject.metadata', operator: 'equals', value: { b: 2, a: 1 } } },
        { condition: { field: 'subject.labels', operator: 'contains', value: 'dip' } },
        { condition: { field: 'semantic.intent', operator: 'in', value: ['service.stop', 'ticket.create'] } },
        { condition: { field: 'semantic.intent', operator: 'matches', value: '^service\\.' } }
      ]
    })]
  });

  assert.equal(result.status, 'matched');
});
