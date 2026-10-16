# Phase 5 Task 5.4 实现审计

## 结论

- 状态：PASS
- 审查人：Jason（`01a145f5-635c-7233-bf74-618522bf8cb8`）
- 审查结论：PASS，无剩余 MUST
- OpenSpec：`iar-five-phase-roadmap` Task 5.4 已标记完成

## 实现范围

- 新增 `@iar/abi`，定义 `iar.control-plane/v1` JSON-safe request/response、操作 allow-list、Manifest Schema 复用和显式 ABI compatibility matrix。
- ABI 边界拒绝未知字段、原型注入、循环/非 JSON 值、过深/过大输入、非法 Manifest 和不支持协议版本；资源预算为 depth 32、nodes 4096、bytes 262144。
- 新增 `@iar/control-plane`，按 tenant 延迟创建独占 `PluginHost`、`RemotePluginDistributor` 和审计数组。
- Policy authorize 在任何 tenant Host 创建前执行；foreign tenant inspect、enable、disable、rollback、audit 和 upgrade 在 runtime 前拒绝。
- install/upgrade 继续委托签名、版本、依赖、capability approval 和回滚语义给 distribution；enable/disable 继续委托 PluginHost 生命周期。
- inspect 优先读取 Host 当前状态，保证 disable 后不会被 stale distribution current 遮蔽；响应只返回 Manifest/版本/状态安全快照。
- control-plane 审计携带 tenant/request/trace/operation/plugin/result，拒绝原始 signature、private key、bundle 和底层异常泄露。

## TDD 证据

### RED

- 先建立 ABI 6 项测试，缺少 `@iar/abi` 时按预期在 build 阶段失败。
- 再建立 control-plane 5 项测试，缺少 `@iar/control-plane` 时按预期失败。

### GREEN

- ABI/control-plane focused：12/12 通过。
- 全量测试：222/222 通过，0 failed、0 skipped、0 todo。
- 回归覆盖：foreign tenant upgrade 在目标 Host 创建前拒绝；ABI artifact 与 dispatcher payload 形状一致；共享引用允许、循环引用拒绝；Manifest 缺失/null/非对象 fail-closed；disable 后 inspect 返回 Host 的 disabled 状态。

## 验证命令

```text
npm ci --dry-run                                      PASS
npm run lint                                          PASS
npm run build                                         PASS
npm test -- --run tests/compatibility/abi-compatibility.test.ts tests/distribution/control-plane.test.ts  PASS (12/12)
npm test                                              PASS (222/222)
openspec validate iar-five-phase-roadmap --strict    PASS
git diff --check                                      PASS
```

## 领域审查

Jason 最终审查通过以下边界：

- 跨语言 JSON ABI 的版本、Schema、allow-list 和资源预算。
- tenant/actor/environment 授权顺序与 foreign tenant Host 访问隔离。
- Policy Gate 不授予 capability，PluginHost 和 RemotePluginDistributor 保持既有语义。
- install、upgrade、enable、disable、rollback、inspect、audit 的生命周期 parity。
- tenant-scoped audit redaction、异常 fail-closed、文件长度和中文注释门禁。
