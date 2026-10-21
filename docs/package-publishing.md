# IAR 包发布

IAR 的两个主要可发布包分别承担 Runtime 和 Pi Bridge 边界：

```text
@iar/runtime       # 独立 IAR Runtime 库
@iar/pi-bridge     # Pi Extension 与 IAR HTTP Bridge client
```

## 构建产物

每个包都从自身 `src/` 编译到 `dist/`：

```text
dist/
├── index.js
├── index.d.ts
├── *.js.map
└── *.d.ts.map
```

`.d.ts` 与对应的 JavaScript 文件放在同一目录，由 `package.json` 的
`types` 和 `exports` 指向。发布包不需要携带 `src/`、测试、模型配置或部署
环境文件。

Pi Bridge 还公开以下子入口：

```text
@iar/pi-bridge/pi-extension
```

该入口同时由 `exports["./pi-extension"]` 和 `pi.extensions` 声明。

## 打包命令

```bash
npm run pack:runtime
npm run pack:pi
npm run pack:verify
```

前两个命令会先构建，再分别生成：

```text
iar-runtime-0.1.0.tgz
iar-pi-bridge-0.1.0.tgz
```

`pack:verify` 会检查所有 workspace 包的入口、类型声明、导出边界和
`npm pack --dry-run` 内容。npm tarball 内部只包含 `package.json` 和 `dist/`。

## 配置边界

模型、端口、数据库和密钥由部署环境提供，不进入 npm 包：

```text
IAR 服务：config/models.yaml、IAR_PORT、IAR_*_MODEL_*
Pi 宿主：IAR_PI_BRIDGE_URL、Pi 自己的模型配置
```

Runtime 和 Pi Bridge 使用 TypeScript 直接编译，不做 minify 或 bundle，保留
source map 以便消费者定位运行时问题。
