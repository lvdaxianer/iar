/** 会话模块边界的轻量静态回归。
 * 这些断言读取源码而非运行时对象，保护拆分后的依赖方向。
 * 正则只针对当前明确的声明形式，不替代完整 TypeScript AST 审计。
 * 类型导出、组件组合和短入口分别失败，便于定位回退位置。
 * 实际会话执行、重置及流式顺序由行为测试另行验证。
 * 结构通过不能证明线程释放、队列串行或模型超限安全。
 * 路径相对于仓库根，测试应由项目测试脚本从该目录启动。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

/* 公开类型与无状态计算各有独立文件，避免组合根重新膨胀。
 * 断言文件存在并检查根模块不重新定义两个代表性计算函数。
 * 类型仍经原公开入口导出，使用方不必修改既有导入路径。
 * 两个辅助函数分别覆盖路由证据和动作摘要的提取边界。
 * 这不限制其他与会话生命周期有关的方法留在组合根。
 */
test('会话公开类型和无状态辅助函数独立于会话组合根', () => {
  const root = 'examples/agent-sandbox/src/';
  assert.ok(existsSync(`${root}session-types.ts`));
  assert.ok(existsSync(`${root}session-helpers.ts`));
  const source = readFileSync(`${root}session.ts`, 'utf8');
  assert.doesNotMatch(source, /function buildEvidence\(/);
  assert.doesNotMatch(source, /function summarizeAction\(/);
  assert.match(source, /export type .* from '\.\/session-types\.js'/);
});

/* 对组合根计算实际换行数，包含导入、文档和空行。
 * 超限时打印测得行数，方便定位需要继续拆分的模块。
 * 此单项检查不代替所有新增源文件的独立行数扫描。
 * 行数包含导出列表，避免只统计类主体而遗漏模块依赖。
 */
test('会话组合根按职责拆分且不超过 350 行', () => {
  const source = readFileSync('examples/agent-sandbox/src/session.ts', 'utf8');
  assert.ok(source.split('\n').length - 1 <= 350, `session.ts 为 ${source.split('\n').length - 1} 行`);
});

/* 普通入口应委托路由及回复组件，而不是再次内联整个流程。
 * 正则从公开方法声明匹配到同缩进结束括号，包含首尾行。
 * 找不到声明时先失败，防止空匹配绕过行数检查。
 * 诊断显示真实长度，超过上限时不会默默跳过该入口。
 */
test('普通对话入口只负责编排且不超过 20 行', () => {
  const source = readFileSync('examples/agent-sandbox/src/session.ts', 'utf8');
  const method = /  public async turn\(text: string\): Promise<TurnResult> \{[\s\S]*?\n  \}/.exec(source);
  assert.ok(method);
  assert.ok(method[0].split('\n').length <= 20, `turn 为 ${method[0].split('\n').length} 行`);
});

/* 流式编排入口和确认入口分别属于不同的职责文件。
 * 两者均检查完整方法体，避免一个入口缩短而另一个变长。
 * 同步的公开委托方法不会被误当作流式编排本体。
 * 循环按方法名选文件，避免错误地只检查组合根的短代理。
 */
test('流式对话与确认入口各不超过 20 行', () => {
  for (const name of ['turnStreamed', 'confirm']) {
    const file = name === 'confirm' ? 'session.ts' : 'session-stream-turn.ts';
    const source = readFileSync(`examples/agent-sandbox/src/${file}`, 'utf8');
    const method = new RegExp(`  public async ${name}\\([\\s\\S]*?\\n  \\}`).exec(source);
    assert.ok(method);
    assert.ok(method[0].split('\n').length <= 20, `${name} 为 ${method[0].split('\n').length} 行`);
  }
});

/* 压缩实例由回复组件持有，而不是靠继承引入额外业务层。
 * 检查构造调用和禁止继承是两个不同的架构约束。
 * 重置后的引用是否实时更新由会话行为测试验证。
 * 独立类声明检查防止仅留下未使用的压缩工厂调用。
 */
test('压缩由独立组件组合，并使用会话实时状态', () => {
  const compaction = readFileSync('examples/agent-sandbox/src/session-compaction.ts', 'utf8');
  const replies = readFileSync('examples/agent-sandbox/src/session-replies.ts', 'utf8');
  assert.match(compaction, /class SandboxSessionCompaction \{/);
  assert.match(replies, /new SandboxSessionCompaction\(/);
  assert.doesNotMatch(replies, /extends SandboxSessionCompaction/);
});

/* 流式组件接收显式能力接口，不应继承普通回复实现。
 * 组合根负责注入依赖，避免组件自行创建第二份会话状态。
 * 这项检查聚焦依赖方向，不验证传入回调的业务顺序。
 * 类型化 context 使依赖可在组件接口中集中审阅。
 */
test('流式编排通过显式会话能力组合，而非继承回复层', () => {
  const stream = readFileSync('examples/agent-sandbox/src/session-stream-turn.ts', 'utf8');
  const session = readFileSync('examples/agent-sandbox/src/session.ts', 'utf8');
  assert.doesNotMatch(stream, /extends SandboxSessionReplies/);
  assert.match(stream, /constructor\(private readonly context: StreamTurnContext\)/);
  assert.match(session, /new SandboxSessionStreamTurn\(/);
});

/* 回复组件由组合根创建，不借继承获得路由职责。
 * recentMessages 通过访问器读取，重置后不会固定旧数组引用。
 * 实际重置与压缩结果在行为测试中通过公开 API 验证。
 * 同一 getter 也供回复历史写入与后续模型输入使用。
 */
test('回复组件与压缩共用会话实时状态，而非继承路由层', () => {
  const replies = readFileSync('examples/agent-sandbox/src/session-replies.ts', 'utf8');
  const session = readFileSync('examples/agent-sandbox/src/session.ts', 'utf8');
  assert.doesNotMatch(replies, /extends SandboxSessionRouting/);
  assert.match(session, /new SandboxSessionReplies\(/);
  assert.match(session, /get recentMessages\(\)/);
});

/* 路由组件不能继承拥有工作线程和事件存储的资源宿主。
 * 会话本身保留对 core 的单层继承，并显式构造路由组件。
 * 这样路由不拥有独立生命周期，也不会额外释放宿主资源。
 * 实际共享的 workflow 与 pending 行为另有重置回归。
 */
test('路由以显式状态接口组合到会话，不能继承资源宿主', () => {
  const routing = readFileSync('examples/agent-sandbox/src/session-routing.ts', 'utf8');
  const session = readFileSync('examples/agent-sandbox/src/session.ts', 'utf8');
  assert.doesNotMatch(routing, /extends SandboxSessionCore/);
  assert.match(session, /new SandboxSessionRouting\(/);
  assert.match(session, /extends SandboxSessionCore/);
});

/* 压缩入口只协调步骤；独立辅助方法负责请求与事件转换。
 * 匹配不到公开方法也要失败，避免改名后静默跳过检查。
 * 下方限制包含声明行和结束行，符合源码物理行口径。
 * 失败信息带有名称和长度，便于评估具体重构范围。
 */
test('压缩入口保持短小并将事件和模型处理分开', () => {
  const source = readFileSync('examples/agent-sandbox/src/session-compaction.ts', 'utf8');
  const method = /  public async compact\([\s\S]*?\n  \}/.exec(source);
  assert.ok(method);
  assert.ok(method[0].split('\n').length <= 20, `compact 为 ${method[0].split('\n').length} 行`);
});

/* 动作准备与决策事件都位于路由职责中，但分别受长度限制。
 * 两个方法可为 public 或 protected，以兼容当前访问边界。
 * 缺少任一方法都会失败，不仅对成功匹配的部分计数。
 * 两个边界分别涉及动作提交和投影事件写入。
 */
test('动作准备和决策事件方法各不超过 20 行', () => {
  const source = readFileSync('examples/agent-sandbox/src/session-routing.ts', 'utf8');
  for (const name of ['prepareAndExecute', 'appendDecisionEvent']) {
    const method = new RegExp(`  (?:public|protected) async ${name}\\([\\s\\S]*?\\n  \\}`).exec(source);
    assert.ok(method);
    assert.ok(method[0].split('\n').length <= 20, `${name} 为 ${method[0].split('\n').length} 行`);
  }
});

/* 澄清兜底与动作回复是两个独立的流式生成路径。
 * 两者分别检查，避免仅优化最常见分支而遗漏另一分支。
 * 模型流取消和响应上限的实际表现由传输测试覆盖。
 * 短入口仍须保留上游异常向调用方传播的语义。
 */
test('流式回复方法各不超过 20 行', () => {
  const source = readFileSync('examples/agent-sandbox/src/session-replies.ts', 'utf8');
  for (const name of ['fallbackReplyStreamed', 'generateReplyStreamed']) {
    const method = new RegExp(`  public async ${name}\\([\\s\\S]*?\\n  \\}`).exec(source);
    assert.ok(method);
    assert.ok(method[0].split('\n').length <= 20, `${name} 为 ${method[0].split('\n').length} 行`);
  }
});

/* 构造函数和执行器工厂负责资源依赖，过长会掩盖清理边界。
 * 同时检查两处核心方法，构造失败的线程释放由子进程测试验证。
 * 本测试只限制源码组织，不模拟资源创建或释放。
 * 检查的是核心实现，而非组合根的组件装配方法。
 */
test('会话构造和执行器工厂各不超过 20 行', () => {
  const source = readFileSync('examples/agent-sandbox/src/session-core.ts', 'utf8');
  for (const name of ['constructor', 'createExecutor']) {
    const method = new RegExp(`  (?:public|protected) ${name}\\([\\s\\S]*?\\n  \\}`).exec(source);
    assert.ok(method);
    assert.ok(method[0].split('\n').length <= 20, `${name} 为 ${method[0].split('\n').length} 行`);
  }
});

/* 启动失败清理与流读取取消分别属于服务和模型传输模块。
 * 两个入口都须保持可审查的长度，辅助逻辑留给专责函数。
 * 模块文件路径包含嵌套目录，避免只检查会话根文件。
 * 缺失任一文件或方法均会使测试失败。
 */
test('启动和流读取入口各不超过 20 行', () => {
  for (const [file, name] of [['server.ts', 'startSandboxServer'], ['models/model-stream-transport.ts', 'readModelStream']]) {
    const source = readFileSync(`examples/agent-sandbox/src/${file}`, 'utf8');
    const method = new RegExp(`(?:export )?async function ${name}\\([\\s\\S]*?\\n\\}`).exec(source);
    assert.ok(method);
    assert.ok(method[0].split('\n').length <= 20, `${name} 为 ${method[0].split('\n').length} 行`);
  }
});

/* 两个压缩辅助入口使用结果上下文，避免传递过多零散参数。
 * 请求与失败事件均检查，防止其中一条路径重新扩大参数列表。
 * 输入内容和事件真实性由压缩行为测试及日志边界测试验证。
 * 保留参数名称断言，避免重构时又拆散关联上下文。
 */
test('压缩请求及失败事件使用共享上下文而非多个零散参数', () => {
  const source = readFileSync('examples/agent-sandbox/src/session-compaction.ts', 'utf8');
  assert.match(source, /buildCompactionRequest\(result: /);
  assert.match(source, /buildCompactionFailureEvent\(result: /);
});
