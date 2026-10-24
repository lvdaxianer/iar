# Design

## Context

`BehaviorContextProjector.current()` 已保存当前单会话的安全状态，包括有界事实链和已完成问答轮次；`projectWorkflowContext()` 已提供不含参数值与确认凭据的 Workflow 投影。当前 Bridge state 只返回 pending 摘要，Pi Host 页面也只保存路由、耗时和事件摘要，因此复制动作无法拿到这些权威状态。

## Goals / Non-Goals

**Goals:**

- 在 Bridge state 响应中提供结构化上下文和 Workflow 的安全投影。
- 在每轮输入、确认/取消及页面重连后同步最新投影到 Pi Host 页面。
- 复制结果保留当前会话已经维护的有界轮次/事实上下文，并通过前端白名单形成稳定快照。
- 让新增字段可选，旧 Bridge 响应仍可被现有客户端消费。

**Non-Goals:**

- 不改变语义抽取、路由、Plugin、Policy、确认或 Action 执行。
- 不复制原始 prompt、reasoning、用户/助手原文、Action input、凭据、confirmation scopeHash 或其他执行授权数据。
- 不切换会话、不新建会话，也不引入持久化模型或新依赖。

## Decisions

1. **复用权威状态而非页面重建。** Bridge state 从 `BehaviorContext` 生成 `structuredContext`，从 `projectWorkflowContext` 生成 `workflowState`。这样复制结果与下一轮模型实际使用的状态一致；替代方案是在浏览器端根据 route/event 拼装，无法覆盖事实链和轮次，也容易与 Runtime 漂移。
2. **安全投影在服务端和页面端各做一次白名单过滤。** 服务端是隐私边界，页面端是复制边界；两层都只允许结构化状态字段，槽位只保留 status/source，确认只保留 state，避免将可执行输入或授权凭据带出。替代方案是深拷贝整份 BehaviorContext，安全边界不足。
3. **状态同步复用现有 state endpoint。** PiHostSession 在 input/confirm 完成后读取同一 IAR session 的 state，并通过现有 SSE 事件通道发送给页面；状态读取失败不改变已完成的业务处置，只向页面给出同步失败提示。替代方案是改变所有 input/confirm response schema，扩大公共协议变更面。
4. **按会话状态导出而非另建前端逐轮缓存。** `conversationTurns` 和 `factHistory` 已由 Runtime 有界维护，页面复制当前投影即可得到完整可恢复上下文；避免刷新或 SSE 重连时丢失浏览器缓存，也避免双重截断。

## Risks / Trade-offs

- [状态读取增加一次只读请求] → 仅用于诊断同步，主输入/确认结果不依赖其成功；失败时保留既有 UI 并提示同步失败。
- [导出内容可能变大] → 复用 Runtime 已有的有界事实和轮次限制，前端不追加无界历史。
- [旧 Bridge 不返回新字段] → 字段保持可选，复制快照以 `null`/空安全占位表示缺失，不阻断既有输入流程。
- [上下文含业务事实] → 仅输出已验证事实信封和结构化元数据，继续排除原始消息、敏感字段和执行输入。

## Migration Plan

1. 先增加协议类型/校验和服务端安全投影测试，再接入 Pi Host 状态事件和复制快照。
2. 新服务端与新页面可与旧客户端兼容；回滚时删除新字段读取不会影响既有 route/timing/pending 展示。
3. 在端口 `8878` 使用真实模型、同一会话验证复制结果及原有话题切换回归。

## Open Questions

无。
