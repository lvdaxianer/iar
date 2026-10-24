# Proposal

## Why

Pi Host 当前把浏览器可见历史与服务端会话生命周期错误地绑定在 SSE 连接上。页面刷新会关闭 SSE，服务端立即销毁 `PiHostSession`，导致虽然 `localStorage` 能回放聊天气泡，Pi Agent transcript、IAR 映射和待确认状态却已经丢失，用户继续追问时上下文不连续。

## What Changes

- 让同一个 Pi Host session ID 在 SSE 断开和重新连接之间继续复用服务端会话。
- 在 Pi Host 服务端增加有界的空闲会话回收，避免断开的页面无限占用内存。
- 增加显式清空会话入口，清空时释放旧服务端会话并生成新的浏览器会话 ID。
- SSE 重连后同步当前待确认动作，使刷新前的确认流程可以继续。
- 保留现有浏览器端有界历史回放；不把原始模型载荷、Action input 或 reasoning 写入浏览器存储。

## Capabilities

### New Capabilities

- `pi-host-session-recovery`: Pi Host 在页面刷新、SSE 重连和显式清空场景下保持会话上下文一致，并安全回收无主会话。

### Modified Capabilities

无。

## Impact

- 影响 `examples/agent-sandbox/src/pi-host/pi-host-server.ts`、`pi-host-session.ts` 和 Pi Host 页面协议适配脚本。
- 新增 Pi Host HTTP 会话清空路由，并改变 SSE 断开后的服务端生命周期行为。
- 增加 Pi Host 页面、服务端会话和待确认状态同步的回归测试。
- 不改变 IAR Bridge 的公开协议、业务执行策略、确认校验或已有持久化 Provider 契约。
