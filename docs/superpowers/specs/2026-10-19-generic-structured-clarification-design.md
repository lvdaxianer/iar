# 通用结构化事实与澄清上下文设计

## 1. 背景

IAR 当前可以把插件执行结果展示给用户，但后续模型决策依赖的结构化上下文没有完整记录两类信息：

- 插件结果中可以被后续追问的事实，例如排队位置、排名、受理号、截止时间等；
- 模型向用户提出的澄清问题及其选项，例如用户回复“1”时，`1` 对应哪个选项。

如果这些信息只存在自然语言回复中，下一轮模型无法稳定恢复；如果把业务字段写死在核心白名单中，每增加一种业务都需要改运行时核心。

## 2. 设计目标

- 插件可以声明任意业务的有限可信事实，核心不感知业务语义。
- 模型每次只接收当前问题和结构化上下文，不依赖原始聊天历史。
- 短输入、数字输入和指代输入可以结合 pending clarification 继续理解。
- 事实、澄清状态、压缩结果和 SQLite 快照可以恢复并保持来源。
- 澄清状态只辅助理解，不具备执行 Function、Plugin 或副作用 Action 的权限。

## 3. 通用数据模型

### 3.1 插件事实信封

插件成功输出可以显式声明 `facts`。运行时只接受 bounded primitive value，并补充来源信息：

```json
{
  "facts": {
    "position": 3,
    "queue": "human.support",
    "receipt": "handoff-20261018-001"
  }
}
```

投影后使用稳定键保存：

```text
<functionId>.<field>
```

每条事实包含：`value`、`verified`、`sourceEventId`、`functionId`、`pluginId` 和 `field`。核心只校验键和值的边界，不解释字段业务含义。

### 3.2 待澄清状态

响应模型可以返回可选的结构化澄清元数据：

```json
{
  "text": "你想查询哪一种排名？",
  "clarification": {
    "kind": "selection",
    "status": "required",
    "options": [
      { "key": "1", "label": "客服/工单排队位置" },
      { "key": "2", "label": "活动排名" },
      { "key": "3", "label": "其他系统序号" }
    ]
  }
}
```

运行时只保存有限数量、长度和唯一性通过校验的选项。选项是理解提示，不是动作选择授权。

## 4. 请求与恢复流程

```text
插件成功输出
  -> 显式 facts 信封
  -> 事件投影 verified facts
  -> 异步 SQLite snapshot
  -> 下一轮读取 BehaviorContext
  -> 当前问题 + facts + pending clarification
  -> 模型回答/澄清/重新进入路由
```

响应元数据变化也通过结构化事件投影并触发快照。压缩只能保留等价的 facts、pending、workflow 和 confirmation；压缩失败时保留上一份有效上下文。

## 5. 提示词边界

模型必须：

1. 优先根据 `status=verified` 的 facts 回答；
2. 把当前输入与 pending options 结合解释短输入和数字输入；
3. 没有事实或存在歧义时反问，并返回结构化 clarification；
4. 不编造事实，不把原始聊天内容当作事实；
5. 不因 pending option 或业务名词自动执行副作用。

模型调用仍然不携带 `recentMessages`，结构化上下文被当作不可信数据读取，不获得系统指令权限。

## 6. 兼容与验证

旧插件没有显式 facts 时仍可正常执行，但不会产生可追问事实。旧快照没有 pending clarification 时按空状态恢复。验证必须覆盖事实追问、数字选项、压缩后继续提问、SQLite 重启恢复、普通/流式一致性、非法元数据拒绝和多会话隔离。流式普通文本可以增量发送；流式澄清使用完整 `iar.response/v1` 响应，宿主只发送 `text`，并投影校验后的元数据，避免 JSON 包装泄露到用户界面。
