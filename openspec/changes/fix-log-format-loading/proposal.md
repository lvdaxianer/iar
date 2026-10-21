# Proposal

## Why

耗时日志已经写出，但演示进程仍显示 JSON，用户无法直接阅读阶段和总耗时。根因是可读格式没有在启动时启用，且 `.env` 的加载发生在日志模块静态初始化之后。

## What Changes

- 让演示启动脚本在加载日志模块前完成 `.env` 加载。
- 让 `IAR_LOG_FORMAT=pretty` 在启动进程中稳定选择中英双语可读 writer。
- 将本地演示配置默认设为 `pretty`，同时保留 `json` 作为显式机器解析选项。
- 增加启动时序回归测试，覆盖 `.env` 配置和显式环境变量。

## Capabilities

### New Capabilities

### Modified Capabilities

- `response-observability`: 日志格式配置必须在日志 writer 初始化前生效，并让本地演示默认输出可读格式。

## Impact

- 影响 `scripts/run-agent-sandbox.mjs`、`scripts/run-pi-host-demo.mjs`、`examples/agent-sandbox/src/safe-log.ts` 及日志观测测试。
- 不改变日志字段白名单、脱敏、traceId 或业务响应协议。
