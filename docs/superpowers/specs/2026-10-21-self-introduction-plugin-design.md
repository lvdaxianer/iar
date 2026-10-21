# IAR 自我介绍 Plugin 设计

## 目标

将“自我介绍”实现为一个真正的内置 Plugin。模型先识别自我介绍意图，再调用该 Plugin 汇总当前 IAR Agent 可用的 Plugin 描述，最后由回复模型生成自然语言答案。

## Agent 创建配置

创建 IAR Agent 时配置 Plugin 集合和介绍偏好：默认所有业务 Plugin 都启用；通过 `disabledPluginIds` 明确关闭指定 Plugin；通过 `selfIntroduction.extraPrompt` 增加只影响自我介绍内容和语气的补充提示词。内置 self-introduction Plugin 默认加入且不可被禁用。新 Plugin 在没有禁用规则时自动加入。

## 运行时链路

```text
createIarAgent(options)
  -> 自动加入 self-introduction Plugin
  -> 过滤 disabledPluginIds
  -> 安装并启用剩余 Plugin
  -> 用户输入
  -> 意图模型选择 self-introduction Function
  -> 汇总当前 Host descriptors + extraPrompt
  -> self-introduction Plugin 返回结构化结果
  -> response.generate 模型生成最终回复
```

介绍 Plugin 只返回 JSON-safe 的能力目录和提示词，不访问宿主内部状态，也不能修改 Plugin 的授权或生命周期。被关闭的 Plugin 不会安装到该 Agent，因此不会进入路由候选、执行宿主或介绍结果。

## 边界与验证

- self-introduction 使用现有 Plugin > Function > Operation 模型，走同一套路由和最终重验证。
- 介绍结果不产生业务事实、不触发确认、不执行副作用。
- 输入、提示词和描述均有长度/数量边界；未知字段和非法 JSON fail-closed。
- scripted sandbox 提供确定性回归；brain 模式将结构化结果交给真实模型。

## 评审结论

该设计不新增独立页面，配置归属于 Agent 创建入口；不在聊天入口加入问候语特殊分支，也不把模型生成的介绍当作权限来源。
