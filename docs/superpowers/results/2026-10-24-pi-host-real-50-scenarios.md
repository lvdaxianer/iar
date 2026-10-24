# Pi Host 真实模型 50 场景验证记录

## 运行条件

- Pi Host：`http://127.0.0.1:8878`，`--brain real`
- 独立验证 Bridge：`http://127.0.0.1:8877`
- 会话策略：50 组连续使用同一个 `piSessionId`，不切换会话；不主动清空上下文
- 输入来源：用户提供的 Agent Sandbox 话题突变 50 例
- 验证工具：`scripts/run-real-pi-50-scenarios.mjs`
- 本次固定映射：`piSessionId=real-50-mvmi1ikc`，`iarSessionId=17THW13bfWsUnlFxsiIkljiDu70m3Ci6`

## 结果

50/50 场景完成，用户轮次 130，`failedScenarios=[]`。

每个用户轮次及确认/取消/压缩后的 state 都检查了：

- `structuredContext.schemaVersion=iar.pi-structured-context/v1`
- `workflowState.mapVersion=iar.workflow-map/v1`
- `conversationTurns` 与 `factHistory` 不回退
- 不出现 `userText`、`assistantText`、`rawPrompt`、`reasoning`、`scopeHash`、`actionInput`、`collected`、`presentation`

| 场景 | 用户轮次 | 最终 IAR turns | facts | 状态投影 | 敏感字段 |
|---:|---:|---:|---:|:---:|:---:|
| 1 | 3 | 4 | 1 | PASS | PASS |
| 2 | 2 | 6 | 1 | PASS | PASS |
| 3 | 3 | 9 | 6 | PASS | PASS |
| 4 | 4 | 12 | 6 | PASS | PASS |
| 5 | 3 | 16 | 7 | PASS | PASS |
| 6 | 3 | 20 | 8 | PASS | PASS |
| 7 | 3 | 23 | 8 | PASS | PASS |
| 8 | 3 | 26 | 9 | PASS | PASS |
| 9 | 2 | 28 | 9 | PASS | PASS |
| 10 | 3 | 32 | 10 | PASS | PASS |
| 11 | 2 | 35 | 11 | PASS | PASS |
| 12 | 2 | 38 | 12 | PASS | PASS |
| 13 | 3 | 42 | 13 | PASS | PASS |
| 14 | 4 | 46 | 13 | PASS | PASS |
| 15 | 4 | 50 | 13 | PASS | PASS |
| 16 | 2 | 52 | 13 | PASS | PASS |
| 17 | 2 | 54 | 13 | PASS | PASS |
| 18 | 3 | 58 | 14 | PASS | PASS |
| 19 | 3 | 63 | 15 | PASS | PASS |
| 20 | 2 | 64 | 15 | PASS | PASS |
| 21 | 2 | 64 | 15 | PASS | PASS |
| 22 | 2 | 64 | 16 | PASS | PASS |
| 23 | 2 | 64 | 17 | PASS | PASS |
| 24 | 2 | 64 | 18 | PASS | PASS |
| 25 | 1 | 64 | 18 | PASS | PASS |
| 26 | 2 | 64 | 18 | PASS | PASS |
| 27 | 3 | 64 | 20 | PASS | PASS |
| 28 | 2 | 64 | 20 | PASS | PASS |
| 29 | 2 | 64 | 24 | PASS | PASS |
| 30 | 3 | 64 | 25 | PASS | PASS |
| 31 | 3 | 64 | 26 | PASS | PASS |
| 32 | 2 | 64 | 30 | PASS | PASS |
| 33 | 5 | 64 | 31 | PASS | PASS |
| 34 | 2 | 64 | 31 | PASS | PASS |
| 35 | 3 | 64 | 32 | PASS | PASS |
| 36 | 2 | 64 | 32 | PASS | PASS |
| 37 | 2 | 64 | 32 | PASS | PASS |
| 38 | 2 | 64 | 32 | PASS | PASS |
| 39 | 2 | 64 | 32 | PASS | PASS |
| 40 | 2 | 64 | 33 | PASS | PASS |
| 41 | 3 | 64 | 37 | PASS | PASS |
| 42 | 4 | 64 | 41 | PASS | PASS |
| 43 | 4 | 64 | 45 | PASS | PASS |
| 44 | 4 | 64 | 45 | PASS | PASS |
| 45 | 2 | 64 | 45 | PASS | PASS |
| 46 | 2 | 64 | 45 | PASS | PASS |
| 47 | 2 | 64 | 46 | PASS | PASS |
| 48 | 2 | 64 | 46 | PASS | PASS |
| 49 | 1 | 64 | 46 | PASS | PASS |
| 50 | 4 | 64 | 46 | PASS | PASS |

## 说明

本记录关注结构化上下文复制链路的技术完整性。`pass_through` 轮由 Pi Agent 兜底，不会新增 IAR `conversationTurns`，但仍同步并保留最新安全 state；验证器因此检查 turn/fact 不回退，而不是要求每个 Pi 兜底轮都新增 IAR turn。业务插件、路由、Policy、确认门禁和执行器未作修改。
