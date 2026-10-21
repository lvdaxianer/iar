# Design

## Context

现有 `PluginHost` 已能从嵌套 Function 注册生成有限候选，`@iar/runtime` 的 `createIarRuntime` 已是 Agent 创建边界，沙箱则负责把语义帧、路由结果、ActionResult 交给回复模型。详见 proposal 与本变更的四份 delta spec。

## Goals / Non-Goals

**Goals:**

- 将自我介绍实现为可路由的内置业务 Plugin，而不是聊天入口的特殊分支。
- 在 Agent 创建时一次性确定默认 Plugin 集合、禁用 Plugin 和自我介绍补充提示词。
- 让自我介绍汇总当前 Agent 的启用能力，并以 JSON-safe 结构交给最终回复模型。
- 让离线 sandbox 与真实模型共用同一 Plugin 描述和路由边界。

**Non-Goals:**

- 不新增独立管理页面或新的持久化数据库表；配置属于创建出的 Agent/runtime 实例。
- 不让自我介绍 Plugin 修改 Plugin 生命周期、授权、策略或实际执行能力。
- 不把所有 Plugin 的业务关键词写入 runtime；意图模型仍通过有限描述自行判断。

## Decisions

### 1. Built-in Plugin uses the existing business routing model

新增 `iar.self-introduction` Plugin 和 `iar.self-introduction` Function，使用低风险、只读的 `query` 动作类型。它作为内置业务包参与现有候选构造，因此真实模型可以用其描述判断“hi/你好/你能做什么”等意图，且仍经过最终 `PluginHost` 重验证。

不使用 system Plugin：system Plugin 按现有契约不能进入业务路由；也不在 session 入口写一个 `if (greeting)`，避免绕过统一意图和授权链。

### 2. Agent creation owns filtering and configuration

`IarRuntimeOptions` 增加 `disabledPluginIds` 与 `selfIntroduction.extraPrompt`。创建时自动加入内置 self-introduction 包，再校验禁用列表、过滤业务包并原子安装启用。self-introduction ID 不允许被禁用，未知禁用 ID 直接稳定失败，避免拼写错误造成静默配置漂移。

配置以不可变快照返回在 `IarRuntime.configuration` 中；新 Plugin 只要未出现在禁用列表，就按默认策略加入。沙箱将相同配置传入每个新会话，避免会话之间共享可变配置。

### 3. The Plugin receives a runtime-projected inventory

自我介绍 Function 的输入只允许包含当前 Agent 已投影的 bounded descriptors，以及可选 bounded `extraPrompt`。session 在准备 Action 时从 `PluginHost.descriptors()` 读取当前能力，排除 self-introduction 自身，再传入 Function Handler。Handler 只做输入校验和 JSON-safe 结构化回显，不持有 Host 或 Handler 引用。

相比让 Handler 直接读取全局 registry，这种方式保持 Function 的纯边界，也保证禁用、生命周期变化和授权过滤已经在输入生成前生效。

### 4. Reply model remains the only natural-language composer

自我介绍 ActionResult 进入现有 `response.generate` 模型输入；brain 模式由真实模型生成自然语言，scripted 模式增加确定性模板用于离线验证。运行时只校验结构化结果，不把模型文本当作 Plugin 清单或执行授权。

### 5. Configuration validation and bounds

禁用 ID 使用有限、去重的字符串数组；补充提示词限制为固定字符上限并在模型输入前复制。输入/输出 Schema 只允许已声明字段，未知字段、数组、超长字符串和非 JSON 值 fail-closed。自我介绍为低风险 read 操作，不请求确认，不产生可信业务事实。

## Risks / Trade-offs

- [Risk] 自我介绍描述与实际能力生命周期不同步 → 每次 Action 准备时从当前 Host 投影 descriptors，不缓存静态目录。
- [Risk] 用户提示词试图重新启用被禁用 Plugin → Agent 创建时过滤并在 Host 中不安装该包，Handler 只接受已投影 inventory。
- [Risk] 内置 Plugin 被业务 Plugin 列表重复提供 → 创建入口在安装前拒绝重复内置 ID，保持唯一注册边界。
- [Risk] 真实模型不识别中文问候 → Function description 明确覆盖介绍语义，scripted provider 增加离线回归；最终意图质量仍属于模型能力，不通过 runtime 关键词分支扩权。

## Migration Plan

1. 先新增内置 Plugin、Agent 配置和 sandbox 行为的失败测试，确认缺失能力导致 RED。
2. 实现 runtime 创建过滤、self-introduction inventory Handler 和 sandbox 回复路径。
3. 运行聚焦测试、相关 runtime/plugin/model 测试及完整 `npm test`。
4. 通过 OpenSpec strict validation、代码规范审查和 per-task audit 后提交并合并到 `master`。

回滚方式是回退本次原子提交；已有 Agent 调用方未传新字段时保持默认全部 Plugin 加 self-introduction 的行为。
