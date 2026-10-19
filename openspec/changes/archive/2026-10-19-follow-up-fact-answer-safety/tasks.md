# Tasks

## 1. 固定语义动作协议

- [x] 1.1 将 semantic.extract 的 `action` 约束为固定 ActionType 或 `unknown`，更新 SemanticFrame 校验和模型 Prompt；验证 semantic contract、Prompt 版本和非法 action 输出测试通过。
- [x] 1.2 更新 scripted provider 与模型输入构造，使查询、明确新动作、上下文追问分别产生正确的 action type；验证离线模式覆盖查询和副作用动作。
- [x] 1.3 增加跨业务语义测试，证明“询问历史结果”不会仅因历史业务词被识别成新的副作用操作；验证测试不依赖具体业务 Function 分支。

## 2. Plugin/Function 候选边界

- [x] 2.1 在 Plugin-first 路由中按语义 action type、routing scope、启用状态和授权结果生成有界 Plugin 候选；验证不兼容 action type 的 Plugin 不进入模型候选。
- [x] 2.2 保持 Plugin 选择后只向模型提供该 Plugin 的 Function/Action 能力，并保留 JEV 优先、Intent Model 兼容 DecisionResult、候选集合和权限重验证；验证现有 scoped-plugin-routing 回归测试及新增 action type 场景通过。
- [x] 2.3 在没有可用 Plugin/Function、模型拒绝或置信度不足时返回稳定未命中/澄清结果，不创建 Action；验证路由证据包含原因码且副作用执行器未被调用。

## 3. Action 执行安全边界

- [x] 3.1 让 Action 输入构造使用语义 action type 与 Function operation kind 做兼容校验，查询或未知不得默认落到副作用 operation；验证查询不会生成 transfer/create/update/delete/execute Action。
- [x] 3.2 对普通和流式入口复用同一 Action 兼容校验及 fail-closed 结果；验证两条路径在不兼容选择下都不进入确认或执行。
- [x] 3.3 保留明确新操作的原有权限、策略、确认、幂等和事实投影行为；验证“重新执行/再次操作”仍能进入确认并在确认后产生 verified facts。

## 4. 无匹配时的模型回答与反问

- [x] 4.1 更新 fallback/response Prompt，明确要求模型根据当前问题和 BehaviorContext 判断直接回答或反问，禁止选择/执行 Function；验证 Prompt 包含 verified facts、pending 和无编造约束。
- [x] 4.2 统一普通与流式 fallback 的输入和结构化 clarification 处理；验证能从事实直接回答、事实不足时反问，且不写入虚假的执行事实。
- [x] 4.3 增加“已完成动作后询问结果”“无相关事实”“问题有歧义”“短输入对应 pending 选项”的通用回答测试；验证不写业务专用分支。

## 5. 集成验证与文档

- [x] 5.1 增加完整会话回归：动作成功后追问结果不重复确认/执行，明确新动作仍正常确认；验证事件序列、BehaviorContext facts 和返回 route 一致。
- [x] 5.2 增加会话恢复与压缩后的追问回归；验证 SQLite/Provider 恢复后的模型输入仍含结构化事实，且无匹配时仍走回答或反问。
- [x] 5.3 更新根目录相关技术文档、OpenSpec 设计和 README 使用说明；验证文档描述与实际候选、fallback 和确认行为一致。
- [x] 5.4 运行类型检查、受影响测试、完整测试和 OpenSpec validate/verify；记录审计证据并确认主工作区用户修改未被覆盖。

## Workflow follow-up

- 完成代码审查、可靠性与安全日志边界审计。
- 提交隔离分支并合并到主分支；合并前保留并解决主工作区已有用户修改。
- 验证合并后的主分支，再归档 OpenSpec 变更并清理该 worktree。
