# Nested Plugin Function Calling

IAR 的主路由把 Plugin 作为 OpenAI-compatible tool 边界，把 Plugin 内的 Function/Operation 放进该工具的参数候选中。模型只负责提出调用，运行时仍负责所有权、授权、Schema、策略、确认、幂等和实际执行。

## 主链路和模型角色

```text
用户输入
  → semantic.extract（普通交互模型，结构化 SemanticFrame）
  → route.propose（普通交互模型，一次 nested tool call）
  → Runtime 重新校验 Plugin / Function / Operation / arguments
  → Function Handler 执行
  → query/read 或 mode=model：response.generate（普通交互模型）
  → action confirmation / form / mode=none：不生成伪聊天回复
```

主路由默认使用普通交互模型（当前示例为 `deepseek-v4-pro`）。`function.select`、`plugin.select` 和旧 `function.call` 只保留给显式兼容入口；兼容入口遵循 JEV 优先、JEV 未配置时使用 Intent Model 的既有规则，不会被新主路由隐式调用。

## OpenAI-compatible tools 格式

每个已启用且已授权的业务 Plugin 投影为一个合法的 OpenAI tool。发送给 `/chat/completions` 的结构固定为：

```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "plugin_ticket_create_v1",
        "description": "工单支持 Plugin；可用 Function/Operation 见描述",
        "parameters": {
          "type": "object",
          "properties": {
            "functionId": { "type": "string", "enum": ["ticket.create"] },
            "operation": { "type": "string", "enum": ["create", "progress"] },
            "arguments": { "type": "object", "additionalProperties": true, "description": "必须符合所选 Function 的 inputSchema" }
          },
          "required": ["functionId", "operation", "arguments"],
          "additionalProperties": false
        }
      }
    }
  ],
  "tool_choice": "auto"
}
```

工具名称只使用 ASCII 字母、数字、`_`、`-`，长度不超过 64；Plugin 原始 ID 会稳定归一化为工具名称。工具外壳只使用 OpenAI 兼容的 `type=function`、`function.name`、`function.description` 和 `function.parameters`，不把 IAR 私有字段放到 OpenAI 的 function 外壳中。IAR 的候选映射和 Function 的 `inputSchema` 保存在宿主侧受控快照，并在执行前再次校验。

模型返回的原生调用形状为：

```json
{
  "tool_calls": [
    {
      "type": "function",
      "function": {
        "name": "plugin_ticket_create_v1",
        "arguments": "{\"functionId\":\"ticket.create\",\"operation\":\"create\",\"arguments\":{\"title\":\"会议室投影仪连不上\",\"priority\":\"high\"}}"
      }
    }
  ]
}
```

`arguments` 是具名 JSON 对象，不使用数组位置。运行时先校验 Function/Operation 是否属于所选 Plugin，再用已安装 Function 的 `inputSchema` 校验 `arguments`；字段缺失、错位、类型错误或额外字段都不会进入 Handler。

## 自定义 Plugin 启动检查

`PluginHost.install()` 是自定义 Plugin 的注册边界。启动或 Agent 创建时会原子校验：

- Plugin、Function、Operation 的 ID、归属和重复冲突；
- Function `actionTypes`、capabilities、risk/confirmation 和 Handler；
- Function `inputSchema` 与 `outputSchema` 的 JSON Schema；
- OpenAI tool 名称、描述长度、工具参数的保守 Schema 子集。

任一 Plugin 契约非法，整个安装/启用流程失败，不生成部分可用的路由候选，也不静默切换到 mock provider。错误只返回稳定的契约错误分类，不回显 API Key、模型正文或原始异常。

## 配置

普通模型 profile 使用 `IAR_LLM_BASE_URL`、`IAR_LLM_API_KEY`、`IAR_LLM_MODEL_ID`。Intent Model 的 `IAR_INTENT_MODEL_*` 只供旧的 JEV/Intent 决策兼容路径使用；它不是 `semantic.extract` 或 `route.propose` 的默认模型。示例 profile 位于 [`examples/agent-sandbox/config/models.brain.json`](../examples/agent-sandbox/config/models.brain.json)。
