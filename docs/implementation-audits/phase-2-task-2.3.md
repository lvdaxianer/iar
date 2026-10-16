# Phase 2 Task 2.3 实现审计

## 结论

Task 2.3 已完成 Function-first 两阶段路由和 Plugin 运行时重验证，未将决策结果直接当作执行授权。

## 范围与边界

- 模块：`packages/runtime/` 路由扩展。
- 覆盖：Function 规则评估与决策、PluginHost enabled business candidates、Plugin 规则评估与决策、ownership/enabled/capability final gate。
- 授权上下文：candidate 与 selected 两个阶段均传递 `tenantId`、`actorId`、`environment` 和冻结宿主记录。
- 不可信输入：Function/Plugin provider 只能从有限候选返回 choice；provider 没有 capability 或 Manifest 写权限。
- 非目标：Policy Gate、confirmation、Action executor、Workflow resume、真实模型、外部数据库和真实插件分发。

## 验收映射

| OpenSpec 要求 | 实现/测试证据 |
| --- | --- |
| SemanticFrame/facts → Function 候选/决策 | `packages/runtime/src/routing.ts` 的 `TwoStageRouter.route`、Function provider 请求投影 |
| Function 后再进入 Plugin | `routePlugin` 只在 Function `choice` 后执行；Function clarification 测试断言 Plugin provider 未调用 |
| Plugin 候选受宿主 enabled/business/functionId 约束 | `PluginHost.candidates`、`RuleEngine.evaluatePlugins`、ownership/no-match 测试 |
| 决策后再次校验 Function ownership 和启用状态 | `PluginHost.resolveCandidate`；disabled stale choice 测试 |
| tenant/actor/environment 重验证 | candidate/selected authorization 测试断言两次完整上下文 |
| provider 不能增加 capability | DecisionCandidate 投影不包含 capability；最终能力只读取冻结 Manifest |
| capability final gate | stale capability snapshot 测试返回 `missing_capability` |
| 稳定拒绝和可审计证据 | RouteResult 保留两阶段 evaluation/decision，覆盖 `plugin_unavailable`、`unauthorized_plugin`、`plugin_ownership_mismatch`、`missing_capability` |

## TDD 与验证证据

- RED：首次执行 `npm test -- --run tests/routing` 因缺少 `TwoStageRouter`/`RouteRequest` 导出而失败。
- GREEN：实现后 focused routing 测试 `32/32` 通过。
- broader verification：`npm run lint`、`npm run build`、`npm test` 全部通过。
- 全量结果：`93/93` 通过。
- package verification：`import('@iar/runtime')` 成功发现 `TwoStageRouter`。
- 结构检查：`git diff --check` 通过；`routing.ts` 350 行，新增路由测试 274 行，测试注释比例约 40.5%。
- 计划一致性：`phase-2-task-2.3-plan.md` 已记录 runtime 路由边界及必要的 decision conditional exports/lockfile 修复。
- OpenSpec：完成前执行 `openspec validate iar-five-phase-roadmap --strict`。

## Review 与修复记录

同一 code-review agent 多轮审查后最终结论为 `PASS`。修复项包括：

- 补齐 `TwoStageRouter`、测试 helper 和路由 helper 的 JSDoc 参数、作者和日期。
- 将多参数结果构造和 finalization helper 改为配置对象，避免长参数列表。
- 补齐 `pluginKind` 分支注释和测试场景注释比例。
- 将 Task 2.2 的 decision conditional exports 与 runtime workspace lockfile 变更写入 Task 2.3 计划边界。
- 区分 PluginHost ownership mismatch 与 unavailable 的稳定 reasonCode。
- 冻结授权 callback 的宿主记录，并增加最终 capability 收缩的回归测试。

## 领域审查

- Backend reliability：Function/Plugin provider 输出均经过 Task 2.2 的统一候选边界校验；空候选、澄清、拒绝、disabled、授权失败和 capability 失败均 fail-closed。
- 权限边界：provider 只能引用规则与宿主生成的 candidateId，不能扩展 capability、改变 Function ownership 或绕过 PluginHost 最终状态。
- 副作用边界：本模块只进行内存评估和宿主快照读取，不执行插件、不写数据库、不调用外部模型。

## 交接

Task 2.3 为 Task 2.4 提供已选 Function/Plugin 和可审计两阶段证据；Policy Gate、confirmation、Action 幂等和 Workflow 状态机仍属于后续任务。
