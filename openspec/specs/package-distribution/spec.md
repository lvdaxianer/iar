# Package Distribution

IAR 的 Node.js 包必须提供稳定、可安装、可类型检查且不暴露仓库内部目录的发布边界；消费者只依赖包声明的公共入口和随包发布的构建产物。

## Requirements

### Requirement: Package exposes a stable compiled entrypoint

每个可发布包 SHALL 从自身包目录的构建产物提供公共运行时入口，消费者不得依赖仓库根目录、其他包的 `src` 目录或包外构建路径。

#### Scenario: Consumer imports the package root

- **WHEN** 消费者从安装后的包名导入公共 API
- **THEN** Node.js 能从该包自身声明的运行时入口加载编译后的 JavaScript，而不需要 TypeScript loader 或仓库根目录存在

#### Scenario: Consumer uses an undeclared internal path

- **WHEN** 消费者导入未在包公共导出表中声明的内部路径
- **THEN** 包边界拒绝该导入，不把 `src`、内部实现目录或未声明构建文件视为公共 API

### Requirement: Package publishes matching type declarations

每个可发布包 SHALL 随运行时代码发布与公共入口对应的 `.d.ts` 类型声明，并通过包元数据提供给 TypeScript 消费者。

#### Scenario: TypeScript consumer imports the package

- **WHEN** TypeScript 消费者导入包公共 API
- **THEN** TypeScript 能解析与运行时入口对应的声明文件，并获得公共类型检查

#### Scenario: Package is packed for publication

- **WHEN** 包被打包为 npm 发布物
- **THEN** 压缩包包含运行时 JavaScript 和类型声明，但不要求包含仓库源码或根级构建目录

### Requirement: Workspace packages use public package boundaries

仓库内的包之间 SHALL 通过稳定的 `@iar/*` 包名或已声明的公共子路径交互，禁止通过相对路径穿透到其他包的 `src` 或 `dist`。

#### Scenario: Package depends on another workspace package

- **WHEN** 一个包引用另一个 IAR 包的类型或运行时 API
- **THEN** 引用使用依赖包的公共名称，并由依赖包的导出声明解析

#### Scenario: Internal source file imports a sibling module

- **WHEN** 一个包内部引用同包的 sibling module
- **THEN** 导入保持在该包边界内，并在 Node 原生 ESM 运行时可解析

### Requirement: Build output is reproducible and validated

仓库 SHALL 能从干净检出重新生成所有可发布包的构建产物，并在发布前验证公共入口、类型入口和包内容的一致性。

#### Scenario: Clean checkout builds packages

- **WHEN** 在没有已提交构建产物的干净检出中执行仓库构建
- **THEN** 所有目标包生成自身的 JavaScript、声明文件和必要 source map，且不依赖上一次构建遗留文件

#### Scenario: Package smoke check runs

- **WHEN** 执行发布包冒烟检查
- **THEN** 检查能够从打包内容导入公共入口、解析类型声明，并发现缺失或越界的发布文件
