# Phase 2 Task 2.2 实现审计

## 结论

Task 2.2 已完成 Mock DecisionProvider 和统一决策结果校验，满足受限决策边界。

## 范围与边界

- 模块：`packages/decision/`。
- 覆盖：有限候选请求、`choice`、score 阈值、`needs_clarification`、`rejected`、`noul`、版本/阶段/候选集合校验。
- 运行时防护：malformed request、候选字段、NaN priority/specificity、额外候选、错误 choice、嵌套快照修改和 provider 异常。
- 非目标：真实 ModelGateway、Function/Plugin Orchestrator、Policy Gate、确认、Action 执行、持久化和外部网络。

## 验收映射

| OpenSpec 要求 | 实现/测试证据 |
| --- | --- |
| Mock DecisionProvider | `packages/decision/src/index.ts` |
| 结构化候选与约束 | `packages/decision/src/types.ts`、`DecisionRequest` |
| choice/score 校验 | `validation.ts`、valid choice/low score/invalid score 场景 |
| rejection/noul | 显式 provider rejection/noul、空候选和 malformed output 场景 |
| 不可区分候选 | priority/specificity 同等级的澄清测试 |
| 不能扩展候选或授权 | choice 越界、candidate set mismatch、候选字段/枚举校验 |
| 稳定错误与诊断 | `invalid_decision_request`、`invalid_decision_output`、`provider_failed` 和 Mock `lastError` |

## TDD 与验证证据

- RED：首次 routing 命令因缺少 `packages/decision/src/index.js` 编译失败。
- GREEN：实现后 routing 测试通过；最终新增决策场景后 routing `26/26` 通过。
- broader verification：`npm run lint`、`npm run build`、`npm test` 全部通过。
- 全量结果：`87/87` 通过。
- package verification：`import('@iar/decision')` 成功发现 `MockDecisionProvider`。
- 结构检查：tracked 与全部新增文件的 diff-check 通过。
- OpenSpec：本任务边界计划已记录于 `phase-2-task-2.2-plan.md`。

## Review 与修复记录

同一 code-review agent 多轮审查后最终结论为 `PASS`。修复项包括：

- workspace 包入口路径与 TypeScript types 路径。
- malformed request 和 malformed candidate 的稳定拒绝。
- requiredSlots、evidenceCodes、riskLevel 和额外字段运行时校验。
- provider 请求快照的嵌套数组隔离和冻结。
- ResultOptions 配置对象、策略化候选排序和完整 JSDoc/分支说明。
- provider 异常的 `provider_failed` 结果和 Mock 诊断上下文。
- 测试文件拆分/注释比例、文件长度和 EOF 检查。

## 领域审查

- Backend reliability：所有 provider 输出均经过公共 Decision Schema 和候选边界校验；低分、空候选、并列和异常路径均不产生可执行 choice。
- 权限边界：决策结果只引用已有候选，不添加 capability、不改变 Function ownership、不绕过 disabled/authorized；真实 registry/tenant/policy 重验证留给 Task 2.3。
- 副作用边界：本模块只运行确定性内存逻辑，不调用网络、数据库、插件或执行器。

## 交接

Task 2.2 可交给 Task 2.3 消费，后续 runtime 将串联 Function/Plugin 两阶段并再次重验证宿主与租户约束。
