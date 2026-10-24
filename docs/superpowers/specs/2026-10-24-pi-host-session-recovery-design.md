# Pi Host 刷新后会话恢复设计

## 背景

Pi Host 页面已经用 `sessionStorage` 保持同一标签页的 session ID，并用
`localStorage` 回放聊天气泡。但服务端在 SSE 断开时立即销毁
`PiHostSession`，所以页面显示历史与 Pi Agent / IAR 的真实上下文不一致。

## 方案

保持现有 session ID 不变，让服务端在 SSE 断开后继续保留对应的
`PiHostSession`。刷新页面重新建立 SSE 后，后续输入复用同一个 Pi Agent
transcript 和 IAR bridge 映射，不重放旧输入，避免重复执行。

服务端会为每个会话记录最近使用时间，仅在没有 SSE 客户端且超过空闲期限
时回收；服务关闭时统一释放。页面的“清空会话”走显式 DELETE 接口，释放
旧会话后再生成新 ID，确保清空是真正的隔离边界。

## 状态同步与安全边界

PiHostSession 只保留脱敏的待确认摘要。SSE 重连在 `ready` 后发送当前
`confirm` 状态，没有待确认动作时也发送 `null`，前端据此清理旧卡片。
Action input、提示词、reasoning 和原始模型载荷不进入浏览器存储或状态同步。

## 验证

- 服务端边界测试验证断开/重连复用原会话，而不是创建新 Agent。
- 待确认、显式清空、不同 session 隔离和空闲回收各有回归测试。
- 页面模板测试验证清空调用服务端 DELETE，并保留现有本地历史回放。
- 最终运行 Pi Host 定向测试、TypeScript 构建和全量测试。
