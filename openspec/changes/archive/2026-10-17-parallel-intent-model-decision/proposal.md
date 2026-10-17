# Proposal

## Why

当前 Function/Plugin 选择路径默认依赖 JEV，虽然 IAR 已经有统一的 `DecisionResult` 校验，但还没有一个可配置的普通意图模型后端作为兼容替代。这样在没有 JEV 的部署环境中，宿主无法复用同一套路由、阈值、澄清和审计逻辑。

## What Changes

- 增加一个与 JEV 并列的 Intent Model Decision Adapter。
- 要求 Intent Model 直接返回现有 `iar.decision/v1`，不引入第二套下游结果协议。
- 增加显式后端选择策略：JEV 与 Intent Model 同时配置时优先 JEV；仅配置 Intent Model 时自动使用 Intent Model。
- 将 Intent Model 的固定 Prompt、输入边界、输出校验和失败语义纳入统一 ModelGateway/DecisionProvider 边界。
- 保持 Function-first、Plugin-second、候选集合、阈值、权限复核和副作用前置门禁不变。
- 增加配置、单元测试、集成测试、故障回退测试和使用文档。

## Capabilities

### New Capabilities

无。Intent Model 是现有受限路由能力的另一个后端，不新增独立运行时能力。

### Modified Capabilities

- `bounded-routing`: Function/Plugin 决策允许 JEV 和 Intent Model 两种后端，但必须产生相同的类型化 `DecisionResult`，并按明确优先级选择后端。

## Impact

- 影响 `packages/decision` 的模型 profile、Decision Adapter 和后端解析逻辑。
- 影响 `config/models.yaml` 与模型配置校验。
- 增加 `tests/integration/model-gateway`、`tests/routing` 和安全边界测试。
- 更新 `docs/README.md`、根目录 `README.md` 和模型配置示例。
- 不改变 `DecisionResult` 的公开字段，不改变现有路由结果和插件执行授权边界。
