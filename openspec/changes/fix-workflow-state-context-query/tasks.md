# Tasks

- [x] T1 更新 Workflow contracts、状态投影、终态开放边界和上下文事件协议
- [x] T2 添加事实追问归一化，并接入普通与流式入口的共同处理路径
- [x] T3 更新 semantic.extract 提示词和模型输入测试
- [x] T4 补充状态安全、普通/流式一致性、Pi bridge 和事实追问回归测试
- [x] T5 执行 Agent Sandbox 手工场景清单并修复发现的问题（使用单一 `piSessionId` 通过 8878 真实 LLM 顺序执行全部 24 个场景；修复 Function descriptor 缺失、历史路由吸附、stale workflow 事件、空确认和多 Function 歧义；压缩模型偶发超时已记录为外部模型性能问题）
- [x] T6 完成 build、lint、目标测试、全量测试、OpenSpec 严格校验和最终审计
