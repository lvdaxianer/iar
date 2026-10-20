# Spec Delta

## MODIFIED Requirements

### Requirement: Package exposes a stable compiled entrypoint

每个可发布包 SHALL 从自身包目录的构建产物提供公共运行时入口；`@iar/plugin` SHALL 提供插件作者定义 Plugin/Function 的入口，`@iar/agent` SHALL 提供应用统一启动入口，消费者不得依赖仓库根目录、其他包的 `src` 目录或包外构建路径。

#### Scenario: Consumer imports the package root

- **WHEN** 消费者从安装后的 `@iar/plugin` 或 `@iar/agent` 导入公共 API
- **THEN** Node.js 能从该包自身声明的编译产物加载 JavaScript，而不需要 TypeScript loader 或仓库根目录

#### Scenario: Consumer uses an undeclared internal path

- **WHEN** 消费者导入 `@iar/plugin`、`@iar/agent` 或其他包未声明的内部路径
- **THEN** 包边界拒绝该导入，不把 `src`、内部实现目录或未声明构建文件视为公共 API

### Requirement: Workspace packages use public package boundaries

仓库内的包之间 SHALL 通过稳定的 `@iar/*` 包名或已声明的公共子路径交互；`@iar/agent` 可以组合 `@iar/contracts`、`@iar/plugins` 和 `@iar/runtime`，但消费者不得穿透到这些包的 `src` 或 `dist`。

#### Scenario: Package depends on another workspace package

- **WHEN** 一个包引用另一个 IAR 包的类型或运行时 API
- **THEN** 引用使用依赖包的公共名称，并由依赖包的导出声明解析

#### Scenario: Internal source file imports a sibling module

- **WHEN** 一个包内部引用同包的 sibling module
- **THEN** 导入保持在该包边界内，并在 Node 原生 ESM 运行时可解析

### Requirement: Build output is reproducible and validated

仓库 SHALL 能从干净检出重新生成 `@iar/plugin` 和 `@iar/agent` 的 JavaScript、声明文件和必要 source map，并在发布前验证两个公共入口的导入和包内容边界。

#### Scenario: Clean checkout builds packages

- **WHEN** 在没有已提交构建产物的干净检出中执行仓库构建
- **THEN** 所有目标包生成自身的 JavaScript、声明文件和必要 source map，且不依赖上一次构建遗留文件

#### Scenario: Package smoke check runs

- **WHEN** 执行发布包冒烟检查
- **THEN** 检查能够从打包内容导入 `@iar/plugin` 与 `@iar/agent`，解析类型声明，并发现缺失或越界的发布文件

## ADDED Requirements

### Requirement: Unified package entries are publishable

`@iar/plugin` SHALL expose Plugin/Function authoring APIs and `@iar/agent` SHALL expose the application startup API from their own package roots with matching runtime and declaration files.

#### Scenario: Application imports the unified entry

- **WHEN** 应用从安装后的 `@iar/agent` 导入统一入口并传入已构建的 Plugin 包
- **THEN** Node.js 和 TypeScript 都能解析该包声明的入口并创建 IAR Runtime

#### Scenario: Plugin author imports the SDK

- **WHEN** 插件包从安装后的 `@iar/plugin` 导入 `definePlugin` 和 `defineFunction`
- **THEN** Node.js 和 TypeScript 都能解析该包声明的运行时入口和类型声明
