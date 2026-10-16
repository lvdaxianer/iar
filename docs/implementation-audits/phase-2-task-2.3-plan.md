# Phase 2 Task 2.3 实现计划

## Task boundary and dispatch

- 模块：`packages/runtime/` 路由扩展。
- 责任：SemanticFrame/facts → Function 候选与决策 → Plugin 候选与决策，并对 PluginHost、租户、actor、environment、ownership 和 capabilities 做运行时重验证。
- 允许修改：`packages/runtime/**`、`tests/routing/**`、本任务审计和 OpenSpec checklist；为让 runtime 正确消费 Task 2.2 的 TypeScript workspace 类型入口，可同步修复 `packages/decision/package.json` 的 conditional exports 和根 `package-lock.json` 依赖锁定。
- 依赖：Task 2.1 `RuleEngine`、Task 2.2 `DecisionProvider`、Phase 1 `PluginHost`。
- 排除范围：Policy Gate、确认、Action executor、Workflow resume、真实模型、外部数据库和真实业务插件分发。
- 聚焦验证：`npm test -- --run tests/routing`。
- 广度验证：`npm run lint && npm run build && npm test`。
- 交接证据：两阶段路由 trace、Function/Plugin 选择证据、宿主状态重验证、tenant/actor/environment 授权回归。

## 设计决策

1. Function 阶段先于 Plugin 阶段；没有唯一可执行 Function choice 时不查询插件。
2. Plugin 规则只评估已选 Function 下的 PluginHost enabled business candidates。
3. PluginHost `resolveCandidate` 在决策后再次执行 ownership 和 enabled 重验证。
4. 外部授权策略每次接收 tenant、actor、environment 和宿主记录；快照筛选与最终选择各验证一次。
5. provider 只能从有限候选中返回 choice，不能增加 capability 或改变宿主 Manifest。
6. 任意重验证失败均返回 rejected，并保留稳定 reasonCode，不进入执行路径。

## 范围一致性说明

`packages/decision/package.json` 的 `types` conditional export 是 runtime 导入 Task 2.2 契约所需的包边界修复；`package-lock.json` 仅记录 runtime 对 decision、plugin-host、rule-engine 的 workspace 依赖。两项变更不扩展业务范围，也不改变 Task 2.2 的运行时语义。
