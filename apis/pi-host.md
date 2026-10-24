# Pi Host 会话 REST API

## 1. 模块概览与覆盖范围

| 项目 | 内容 |
| --- | --- |
| 业务模块 | Pi Host 会话（`pi-host`） |
| 文档路径 | `apis/pi-host.md` |
| 模块职责 | 为本地 Pi Host 演示页提供 SSE 事件、聊天、确认和会话清空能力 |
| 基础 URL / 版本 | `http://127.0.0.1:<port>`；当前示例服务无独立 API 版本前缀 |
| 通用认证与约定 | 仅面向本地演示宿主；当前实现无认证、无 Cookie、无幂等键。生产部署的认证和租户授权待确认。响应为 JSON，SSE 使用 `text/event-stream`。 |

### 1.1 对外 route 覆盖表

| Controller / route 归属 | 对外端点 | 文档章节 | 覆盖状态 |
| --- | --- | --- | --- |
| `buildPiHostApp` | `GET /` | [页面响应](#21-页面响应) | 已覆盖 |
| `buildPiHostApp` | `GET /api/pi-host/events` | [SSE 事件流](#22-sse-事件流) | 已覆盖 |
| `buildPiHostApp` | `POST /api/pi-host/chat` | [提交聊天输入](#23-提交聊天输入) | 已覆盖 |
| `buildPiHostApp` | `POST /api/pi-host/confirm` | [确认或取消动作](#24-确认或取消动作) | 已覆盖 |
| `buildPiHostApp` | `DELETE /api/pi-host/session/{sessionId}` | [清空 Pi Host 会话](#25-清空-pi-host-会话) | 已覆盖 |
| `registerPiBridgeRoutes` | `GET /api/bridge/v1/sessions/{sessionId}/state` | [读取 Bridge 结构化上下文状态](#31-读取-bridge-结构化上下文状态) | 已覆盖 |

## 2.1 页面响应

### 2.1.1 Method and URL

```http
GET http://127.0.0.1:<port>/
```

请求参数、请求体、请求头和 Cookie：不适用。页面返回 `text/html; charset=utf-8` 的自包含 Pi Host HTML。

### 2.1.2 Response

| HTTP 状态码 | 业务含义 | 调用方处理 |
| --- | --- | --- |
| `200 OK` | 页面拼装成功 | 在浏览器中加载页面 |
| `500 Internal Server Error` | 页面资源拼装失败 | 检查本地部署资源和服务日志 |

响应 Cookie：不适用。响应体是 HTML 文本，无 JSON 字段表。

## 2.2 SSE 事件流

### 2.2.1 Method and URL

```http
GET http://127.0.0.1:<port>/api/pi-host/events?session=<sessionId>
```

| 参数 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `session` | query string | 是 | 长度 1-128；事件流路由只校验长度，聊天和清空路由还要求 `[A-Za-z0-9_-]` | Pi Host 会话标识 |

请求体、认证、Request Cookie：不适用。客户端应使用 `Accept: text/event-stream`；服务端不强制校验该 header。

### 2.2.2 Response

`200 OK` 返回 `text/event-stream; charset=utf-8`，事件使用 `event: <name>` 与 JSON `data:`。连接关闭表示客户端断开，服务端不会因此立即清空同一 session 的 Pi Host 上下文。

已确认事件包括：`ready`、`route`、`timing`、`entry`、`confirm`、`notify`、`piDelta`、`piDone`、`iarReasoningDelta` 和 `iarDelta`。`confirm` 的数据为待确认摘要或 `null`。

`400 Bad Request`：缺少或超长 `session`。错误响应为 `{ "error": "invalid_session" }`。响应 Cookie：不适用。

### 2.2.3 curl 示例

```bash
curl --no-buffer 'http://127.0.0.1:8788/api/pi-host/events?session=SESSION_PLACEHOLDER' \
  --header 'Accept: text/event-stream'
```

## 2.3 提交聊天输入

### 2.3.1 Method and URL

```http
POST http://127.0.0.1:<port>/api/pi-host/chat
```

请求头：`Content-Type: application/json`；认证、Cookie、幂等键：不适用。

#### requestBody

```json
{
  "session": "SESSION_PLACEHOLDER",
  "text": "你好"
}
```

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `session` | string | 是 | `[A-Za-z0-9_-]{1,128}` | Pi Host 会话标识 |
| `text` | string | 是 | trim 后非空且不超过 4096 字符 | 用户输入 |

### 2.3.2 Response

`200 OK` 返回 `{ "action": "handled" }` 或 `{ "action": "continue" }`。`handled` 表示 IAR 已给出结果，`continue` 表示交给 Pi Agent 兜底；最终展示事件通过 SSE 发送。

`400 Bad Request`：session 非法或 text 为空/超长，返回 `{ "error": "invalid_session" }` 或 `{ "error": "invalid_input" }`。其他服务端错误：待确认，调用方应保留输入并检查 SSE 状态，不应自动重试可能已执行的输入。

### 2.3.3 curl 示例

```bash
curl --request POST 'http://127.0.0.1:8788/api/pi-host/chat' \
  --header 'Content-Type: application/json' \
  --data '{"session":"SESSION_PLACEHOLDER","text":"你好"}'
```

## 2.4 确认或取消动作

### 2.4.1 Method and URL

```http
POST http://127.0.0.1:<port>/api/pi-host/confirm
```

请求头：`Content-Type: application/json`；认证、Cookie、幂等键：不适用。

#### requestBody

```json
{
  "session": "SESSION_PLACEHOLDER",
  "accepted": true
}
```

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `session` | string | 是 | `[A-Za-z0-9_-]{1,128}` | Pi Host 会话标识 |
| `accepted` | boolean | 是 | `true` 确认，`false` 取消 | 用户选择 |

### 2.4.2 Response

`200 OK` 返回 `{ "ok": true }` 或 `{ "ok": false }`。`400 Bad Request` 返回 `invalid_session` 或 `invalid_accepted`。响应不包含 Action input。

## 2.5 清空 Pi Host 会话

### 2.5.1 Method and URL

```http
DELETE http://127.0.0.1:<port>/api/pi-host/session/{sessionId}
```

| 项目 | 内容 |
| --- | --- |
| Path parameter | `sessionId`：必填，`[A-Za-z0-9_-]{1,128}`；表示要清空的 Pi Host 会话 |
| Query parameters | 不适用 |
| requestBody | 不适用 |
| Request headers | 不适用；`Accept: application/json` 可选 |
| Request cookies | 不适用 |
| 认证/授权 | 当前本地演示无认证；生产授权待确认 |
| 幂等性 | 幂等；未知或已过期 session 也返回成功 |

### 2.5.2 Response

成功返回 `200 OK`：

```json
{
  "ok": true
}
```

调用方应随后删除本地历史、生成新 session ID 并重新建立 SSE。`400 Bad Request` 返回 `{ "error": "invalid_session" }`。响应 Cookie：不适用。

### 2.5.3 curl 示例

```bash
curl --request DELETE 'http://127.0.0.1:8788/api/pi-host/session/SESSION_PLACEHOLDER'
```

## 2.6 安全与生命周期约定

- session ID 只作为会话索引，不是认证凭据；当前本地演示服务不提供跨用户访问控制。
- 服务端只同步脱敏的待确认摘要，不返回 Action input、提示词、reasoning 或模型原始载荷。
- SSE 断开后服务端按空闲期限回收无客户端会话；服务关闭时释放全部会话。
- 页面在聊天或确认请求进行中禁用清空操作，避免中途释放正在执行的会话。

## 3.1 读取 Bridge 结构化上下文状态

### 3.1.1 Method and URL

```http
GET http://127.0.0.1:<port>/api/bridge/v1/sessions/{sessionId}/state
```

| 项目 | 内容 |
| --- | --- |
| Path parameter | `sessionId`：必填，IAR 会话标识；由 `POST /api/bridge/v1/sessions` 返回，格式为 32 位 `[A-Za-z0-9_-]` |
| Query parameters | 不适用 |
| requestBody | 不适用 |
| Request headers | `Accept: application/json` 可选；无认证 header |
| Request cookies | 不适用 |
| 幂等性 | 只读；重复读取不会改变会话业务状态 |

### 3.1.2 Response

成功返回 `200 OK`。`pending` 仅在存在待确认动作时出现；`structuredContext` 与 `workflowState` 始终返回当前会话的安全投影。

```json
{
  "version": "iar.pi-bridge/v1",
  "iarSessionId": "IAR_SESSION_PLACEHOLDER",
  "structuredContext": {
    "schemaVersion": "iar.pi-structured-context/v1",
    "subject": { "type": "ticket", "id": "ticket-1", "status": "resolved", "source": "context" },
    "intent": "ticket.lookup",
    "action": { "name": "lookup", "status": "resolved" },
    "route": { "functionId": "ticket.lookup", "pluginId": "ticket-plugin" },
    "slots": { "title": { "status": "resolved" } },
    "workflow": { "currentStep": "normal", "status": "running" },
    "pending": { "kind": "input", "status": "none" },
    "confirmation": { "state": "not_required" },
    "factHistory": { "records": [], "focusRecordId": "fact-1" },
    "conversationTurns": { "turns": [], "focusTurnId": "turn-1" },
    "integrity": { "criticalFieldHash": "HASH_PLACEHOLDER", "lastEventId": "EVENT_PLACEHOLDER" }
  },
  "workflowState": {
    "mapVersion": "iar.workflow-map/v1",
    "currentState": "normal",
    "activeState": "normal",
    "outcome": "none",
    "workflowStatus": "running",
    "allowedEvents": ["input"],
    "pending": { "kind": "input", "status": "none" },
    "confirmation": { "state": "not_required" }
  }
}
```

`structuredContext` 保留结构化意图、路由、字段状态、已验证事实和有界轮次元数据；轮次中的用户/助手原文、槽位 `value`、参数收集值、待解析引用 `text`、确认 `scopeHash`、Action input、幂等键和 reasoning 均不返回。`workflowState` 复用运行时 Workflow projection，只保留状态、允许事件和字段/候选摘要，不产生执行授权。

`404 Not Found` 或 `409 Conflict`：会话不存在、已失效或当前会话正由其他操作占用，返回统一 Bridge 错误结构：

```json
{
  "version": "iar.pi-bridge/v1",
  "code": "session_not_found",
  "message": "IAR 会话请求未完成。",
  "retryable": false
}
```

`500 Internal Server Error`：状态读取失败，返回 `bridge_internal_error`；响应 Cookie：不适用。

### 3.1.3 curl 示例

```bash
curl --request GET 'http://127.0.0.1:8788/api/bridge/v1/sessions/IAR_SESSION_PLACEHOLDER/state' \
  --header 'Accept: application/json'
```
