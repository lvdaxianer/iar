# Nested Plugin/Function Routing Task 4.2 审计

## 结论

- 状态：通过。
- `function-response/v1` 是 Function 执行结果到回复层的唯一分流契约。

## 分流规则

- `mode: "model"`：把已校验的 `ActionResult.output`、Function/Plugin 身份、Operation 类型、会话上下文和三层提示词交给 `response.generate`，由 Response Model 生成用户可读内容。
- `mode: "direct"`：仅直出 Function 契约中允许的固定文本，不调用 Response Model。
- `mode: "none"`：不生成聊天正文，保留确认/表单等 UI 元数据，不伪造“已完成”回复。
- 执行失败仍保留真实动作状态；Response Model 失败时返回稳定错误摘要，不把失败伪装成成功。

## Evidence

- `tests/integration/agent-sandbox/self-introduction.test.ts` 覆盖查询/自我介绍使用 `response_model`、direct/none 不调用回复模型、流式与非流式一致。
- `examples/agent-sandbox/src/session-replies.ts` 的 `directReply`、`streamedDirectReply` 和 `generateReply` 共享同一分流边界。
- nested route 只负责产生经 Runtime 校验的 Function 参数，不改变 Response Contract。
