# Design

## 目标边界

把 Function 执行结果分成三类：需要结合用户原话和会话上下文重新组织的 `model`，已经是安全完整用户话术的 `direct`，以及只改变确认/表单/UI 状态而不产生聊天文本的 `none`。动作是否有副作用不决定回复模式；例如限流调整可以执行动作后交给模型汇总，而确认动作可以完全不调用回复模型。

## 固定协议

Function 的输入和业务输出继续由 `FunctionDefinition.inputSchema` 与 `outputSchema` 明确声明。Handler 结果新增固定的响应信封：

```ts
type FunctionResponse = {
  schemaVersion: 'iar.function-response/v1';
  mode: 'model' | 'direct' | 'none';
  text?: string;
  ui?: JsonValue;
};
```

`direct` 必须携带有界 `text`，`none` 不得携带聊天文本，`model` 只能携带有界、标记为数据的辅助字段，不能携带 Plugin、Function、权限或执行指令。业务 `output` 仍按 Function 自己的 outputSchema 校验，响应信封按统一 Schema 校验。

## 启动与执行校验

PluginHost 的安装准备阶段编译并校验每个 Function 的 input/output Schema、响应 Schema 和 Handler 类型，任何失败都返回稳定错误且不写入注册表。执行桥在调用 Handler 前校验输入，调用后校验 `FunctionHandlerResult`、业务输出和响应信封；校验失败进入 Action failed，不把未验证内容传给回复模型或用户。

启动阶段不能证明 Handler 对所有输入都正确，因此执行边界仍必须重复校验。所有错误只暴露稳定错误码和有限字段路径，不回显原始输入、输出或异常文本。

## 回复分流

普通和流式执行路径共享同一分流器：

- `model`：把用户原话、结构化上下文、Function/Plugin 标识和已校验业务输出作为数据传给 `response.generate`。
- `direct`：只返回已校验的 `response.text`，不调用回复模型。
- `none`：返回结构化状态供确认、表单或宿主 UI 消费，不生成普通聊天消息；如果公共 HTTP/Bridge 协议要求文本，则使用固定空状态映射，不把业务输出当文本展示。

自我介绍固定使用 `model`，限流调整这类结果可以使用 `model`，确认、填写表单和纯 UI 状态使用 `none`，参数错误和权限错误由运行时固定话术处理。

## 兼容与安全

现有示例 Plugin 全部迁移到固定响应信封。旧版缺失响应信封的注册在新协议下启动失败，不隐式猜测模式。响应模式是运行时数据，不是模型指令；模型只能生成文本，不能改变模式、执行权限、候选集或确认状态。

## 验证策略

- 契约测试覆盖合法/非法响应信封、三种模式和有界字段。
- PluginHost 测试覆盖启动期 Schema 编译失败、Handler 缺失、批量原子失败。
- 执行测试覆盖输入/输出不匹配、异常输出和稳定 Action 失败。
- Session 测试覆盖 self-introduction/model、direct 不调用模型、none 不写聊天消息，以及普通/流式路径一致。
- 运行 lint、build、聚焦测试、全量测试和 OpenSpec 严格校验。
