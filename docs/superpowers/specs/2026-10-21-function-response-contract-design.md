# Function Response Contract 设计

## 目标

为所有自定义 Function 建立稳定的输入/输出和回复分流协议。Function 负责返回结构化业务结果，运行时负责校验，并按结果声明决定交给模型、直接返回或仅更新 UI 状态。

## 核心决策

- `model`：结果需要结合上下文组织语言，例如自我介绍、限流调整结果、知识检索结果。
- `direct`：Function 已返回完整、有限、可直接展示的话术。
- `none`：确认、表单和 UI 状态，不生成普通聊天回复。
- 启动注册时校验 Schema；真实执行时再次校验输入输出。
- 任意非法 Schema 或非法 Handler 结果都 fail-closed，禁止部分注册和未验证内容外泄。

## 数据流

```text
Function inputSchema
  -> runtime 校验输入
  -> Handler 执行
  -> outputSchema + response contract 校验
  -> model / direct / none 分流
```

## 验证范围

覆盖契约边界、启动原子性、运行时非法输出、普通/流式回复一致性、自我介绍模型汇总以及确认/表单不调用回复模型。
