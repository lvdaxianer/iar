# Phase 2 Task 2.1 实现审计

## 结论

Task 2.1 已完成实现和验证，满足 `iar-five-phase-roadmap` 的受限路由规则引擎验收边界。

## 范围与边界

- 模块：`packages/rule-engine/`。
- 覆盖：`FunctionRule`、`PluginRule`、`ALL`/`ANY`/`NONE`、未知字段策略、优先级/特异性排序、冲突澄清、匹配/排除证据、插件快照门禁。
- 安全边界：运行时 RuleDefinition 校验、JSON-safe facts 校验、facts 深度/节点/循环保护、表达式深度/宽度预算、正则长度和嵌套量词限制。
- 非目标：真实 PluginHost/Policy Gate 的再次重验证、确认执行、Action 幂等、重试和恢复；这些由 Task 2.3/2.4 负责。
- 副作用边界：规则引擎只生成有限候选和证据，不授权、不执行插件、不修改 BehaviorContext、不访问网络或数据库。

## 验收映射

| OpenSpec 要求 | 实现/测试证据 |
| --- | --- |
| FunctionRule 与 PluginRule | `packages/rule-engine/src/index.ts`、`types.ts`、`tests/routing/` |
| ALL/ANY/NONE | `expression-evaluator.ts` 及组合规则测试 |
| 未知字段策略 | `unknown_field`、`unknown_field_rejected` 测试 |
| 优先级/特异性冲突 | `candidate-evidence.ts` 及 `needs_clarification` 测试 |
| 匹配/排除证据 | `candidate-ranking.ts`、`candidate-evidence.ts`、候选断言 |
| 插件门禁 | `plugin-guards.ts` 及 disabled/unauthorized/归属/能力测试 |
| fail-closed 资源边界 | `regex-safety.ts`、facts/表达式预算回归测试 |

## TDD 与验证证据

- RED：首次聚焦测试在缺少 `packages/rule-engine/src/index.js` 时失败，证明测试先于实现建立。
- GREEN：实现后聚焦路由测试通过；最终拆分测试文件后仍为 routing `12/12`。
- broader verification：`npm run lint`、`npm run build`、`npm test` 全部通过。
- 全量结果：`73/73` 通过。
- 结构检查：`git diff --check` 及所有未跟踪文件的 `git diff --no-index --check /dev/null <file>` 通过。
- OpenSpec：`openspec validate iar-five-phase-roadmap --strict` 通过。

## Review 与修复记录

同一 code-review agent 完成多轮审查，最终结论为 `PASS`。修复项包括：

- 嵌套量词、宽表达式、facts 共享引用和 facts 深度/节点预算。
- 当前递归路径的循环检测及共享引用 deep equality。
- `CONDITION_EVALUATORS` 策略映射、递归 `EvaluationContext` 和 facts 校验拆分。
- 运行时契约校验、包根内部 evaluator 导出收口、lower-priority ruleId 证据。
- 文件长度 ≤350 行、方法参数/JSDoc、分支说明和测试/fixture 注释比例。
- 测试文件拆分及共享 equals 回归测试。

## 领域审查

- Backend reliability：输入在公共 Schema 和 JSON-safe 边界校验后才进入纯内存评估；未知字段、资源超限、非法正则和冲突均 fail-closed；没有外部副作用或敏感日志输出。
- Workflow/decision 交接：当前结果保留候选、规则版本、风险、槽位、证据和冲突信息，供后续 Decision/Policy/Workflow 模块消费。
- Deferred risk：PluginHost 真实性重验证、tenant/environment/actor 权限再次校验必须在 Task 2.3 完成，当前快照门禁不能替代该校验。

## 交接

Task 2.1 的代码、测试和本审计文件可交给 `bounded-routing-workflow` 模块继续实现 Task 2.2；本任务不提前标记后续任务完成。
