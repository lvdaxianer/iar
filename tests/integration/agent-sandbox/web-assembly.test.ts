/** 自包含首页拼装、页面片段职责与启动清理回归。
 * 使用真实模板及磁盘资源验证服务返回的 HTML，而非模拟加载器。
 * 页面交互由独立的标签页测试覆盖，这里只检查资源及渲染边界。
 * Markdown 示例包含可执行标签和属性，确保未经信任文本被转义。
 * 子进程测试用于观察启动失败后线程是否阻止进程退出。
 * 页面原有 NUL 字节属于兼容数据，不能在拆分或拼装中悄悄丢失。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { startSandboxServer } from '../../../examples/agent-sandbox/src/server.js';

/* 页面现在只使用流式聊天入口，旧非流式处理器不再有调用者。
 * 禁止重新引入该名称，避免死代码被误认为仍是受支持的回退链路。
 * 此检查不禁止服务端保留普通聊天协议，兼容客户端仍可调用。
 * 控件片段从磁盘读取，确保检查的是实际随页面交付的源文件。
 */
test('页面不保留未调用的非流式回复处理器', () => {
  const controls = readFileSync('examples/agent-sandbox/web/controls.fragment.js', 'utf8');
  assert.doesNotMatch(controls, /\bhandleTurnResult\b/);
});

/* 首尾片段共同组成严格模式的块作用域，避免全局变量碰撞。
 * 片段不是各自独立执行，必须同时检查起始和结束边界。
 * 禁止整页 IIFE，防止以一个超长函数隐藏内部方法长度问题。
 * 完整拼装后的脚本执行及各函数长度还需由其他测试和 AST 检查。
 */
test('页面词法隔离不依赖覆盖整页的巨型函数', () => {
  const first = readFileSync('examples/agent-sandbox/web/session.fragment.js', 'utf8');
  const last = readFileSync('examples/agent-sandbox/web/controls.fragment.js', 'utf8');
  assert.match(first, /^\s*['"]use strict['"];\s*\{/);
  assert.match(last, /\n\}\s*$/);
  assert.doesNotMatch(first, /^\s*\(function/);
});

/* 确认框、流式聊天和状态刷新分别承担不同的交互职责。
 * 检查源片段拼接后的声明，匹配失败也必须报错。
 * 物理行数包含函数首尾，避免以缺失方法绕过长度限制。
 * 点击禁用、确认绑定和 SSE 错误状态由页面行为测试验证。
 */
test('页面确认和流式聊天入口按职责拆分', () => {
  const source = ['interaction.fragment.js', 'stream.fragment.js', 'controls.fragment.js']
    .map((name) => readFileSync(`examples/agent-sandbox/web/${name}`, 'utf8')).join('');
  for (const name of ['showConfirmBox', 'streamChat', 'refreshState']) {
    const method = new RegExp(`  function ${name}\\([\\s\\S]*?\\n  \\}`).exec(source);
    assert.ok(method);
    assert.ok(method[0].split('\n').length <= 20, `${name} 为 ${method[0].split('\n').length} 行`);
  }
});

/* 在隔离 VM 中运行真实 Markdown 片段与逐行解析辅助函数。
 * 标题、列表、强调和代码块共同验证原有安全子集的输出结构。
 * script 文本位于代码块时仍需转义，不能变成可执行标签。
 * img 事件属性作为普通文本处理，不能成为浏览器事件处理器。
 * 不依赖浏览器 DOM，确保断言针对生成的完整 HTML 字符串。
 */
test('Markdown 安全子集保留代码块、列表和转义行为', () => {
  const source = readFileSync('examples/agent-sandbox/web/markdown.fragment.js', 'utf8');
  const helpers = readFileSync('examples/agent-sandbox/web/markdown-lines.fragment.js', 'utf8');
  const render = runInNewContext(`${source}\n${helpers}\nrenderMarkdown`) as (text: string) => string;
  assert.equal(render('# 标题\n- **一**\n- 二\n\n```<script>```'), '<h3>标题</h3><ul><li><strong>一</strong></li><li>二</li></ul><p><pre><code>&lt;script&gt;</code></pre></p>');
  assert.equal(render('<img onerror="x">'), '<p>&lt;img onerror=&quot;x&quot;&gt;</p>');
});

/* 渲染入口委托行解析，保持独立职责和可审阅的方法体。
 * 缺失方法先触发断言，避免正则找不到时错误地认为满足上限。
 * 转义正确性由上一个行为测试检查，不由行数代替。
 */
test('Markdown 渲染入口不超过 20 行', () => {
  const source = readFileSync('examples/agent-sandbox/web/markdown.fragment.js', 'utf8');
  const method = /  function renderMarkdown\([\s\S]*?\n  \}/.exec(source);
  assert.ok(method);
  assert.ok(method[0].split('\n').length <= 20, `renderMarkdown 为 ${method[0].split('\n').length} 行`);
});

/* 普通消息与 SSE 气泡分别属于交互和流式片段。
 * 两个构造入口都要有界，避免某条路径重新累积 DOM 细节。
 * 这里只检查结构；具体用户可见内容另由会话页面测试覆盖。
 */
test('页面消息及流式气泡入口不超过 20 行', () => {
  for (const [file, name] of [['interaction.fragment.js', 'appendMsg'], ['stream.fragment.js', 'createStreamBubble']]) {
    const source = readFileSync(`examples/agent-sandbox/web/${file}`, 'utf8');
    const method = new RegExp(`  function ${name}\\([\\s\\S]*?\\n  \\}`).exec(source);
    assert.ok(method);
    assert.ok(method[0].split('\n').length <= 20, `${name} 为 ${method[0].split('\n').length} 行`);
  }
});

/** 使用临时端口启动真实沙箱，避免测试之间端口冲突。
 * 先释放端口探针，再让服务绑定；绑定失败必须向测试传播。
 * 返回句柄由调用方在 finally 中关闭，确保线程得到释放。
 * @returns 启动后的沙箱服务
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
async function startPageServer(): Promise<Awaited<ReturnType<typeof startSandboxServer>>> {
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const address = probe.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return startSandboxServer({ mode: 'scripted', port: address.port });
}

/** 检查浏览器不必再请求外部资源，并保留原有二进制字符。
 * 禁止残留模板标记或外链脚本和样式，保持 GET / 自包含契约。
 * 精确 NUL 数量防止 UTF-8 读取、拼接或传输损坏原有资源内容。
 * 检查代表性会话与 Markdown 函数存在，避免只返回空资源标签。
 * @param body - 首页响应内容
 * @returns 无返回值，断言失败时抛错
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
function assertSelfContainedPage(body: string): void {
  assert.match(body, /<style>/); assert.match(body, /<script>/);
  assert.doesNotMatch(body, /IAR_SANDBOX_(?:STYLES|SCRIPT)/);
  assert.doesNotMatch(body, /<script[^>]+src=|<link[^>]+stylesheet/);
  assert.equal([...body].filter((character) => character === '\0').length, 4);
  assert.ok(body.includes('function initializeSession()'));
  assert.ok(body.includes('function renderMarkdown(src)'));
}

/** 根据源文件顺序独立计算响应，保护启动时拼装契约。
 * 替换回调保留资源中的美元符号，不触发字符串替换特殊展开。
 * 两个占位符必须存在，脚本按运行时依赖的顺序依次拼接。
 * 与响应整体比较可以发现片段遗漏、顺序变化或字节丢失。
 * @returns 完整的预期 HTML
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
function expectedPage(): string {
  const base = 'examples/agent-sandbox/web/';
  const template = readFileSync(`${base}index.html`, 'utf8');
  assert.match(template, /IAR_SANDBOX_STYLES/); assert.match(template, /IAR_SANDBOX_SCRIPT/);
  const styles = readFileSync(`${base}styles.css`, 'utf8');
  const names = ['session.fragment.js', 'markdown.fragment.js', 'markdown-lines.fragment.js', 'interaction.fragment.js', 'stream.fragment.js', 'sessions.fragment.js', 'controls.fragment.js'];
  const script = names.map((name) => readFileSync(`${base}${name}`, 'utf8')).join('');
  return template.replace('<!-- IAR_SANDBOX_STYLES -->', () => `<style>${styles}</style>`)
    .replace('<!-- IAR_SANDBOX_SCRIPT -->', () => `<script>${script}</script>`);
}

/* 实际启动服务并请求首页，检查 HTTP 状态和 HTML 内容类型。
 * 自包含断言确认浏览器无需额外资源请求，且原有 NUL 被保留。
 * 再与独立拼装的模板比较，避免只检查少数标记而遗漏某个片段。
 * 使用注入请求不影响服务器启动及磁盘读取真实路径。
 * finally 关闭服务，防止会话工作线程在测试失败时继续运行。
 */
test('页面模板在启动时拼装为自包含响应并保留 NUL', async () => {
  const server = await startPageServer();
  try {
    const response = await server.app.inject({ method: 'GET', url: '/' });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type']!, /text\/html/);
    assertSelfContainedPage(response.body);
    assert.equal(response.body, expectedPage());
  } finally { await server.close(); }
});

/* 子进程在导入服务器前替换 fs 读取，模拟样式资源不可用。
 * syncBuiltinESMExports 确保 ESM 导入观察到同一读取替身。
 * 启动必须失败并输出明确标记，不能静默返回缺样式的页面。
 * 正常退出说明启动时已创建的线程没有让子进程无限存活。
 * 超时用于发现资源泄漏，不作为页面加载性能指标。
 * 替换只发生在子进程，不影响其他测试的真实文件读取。
 */
test('页面资源读取失败时启动失败且工作线程释放', () => {
  const code = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync; fs.readFileSync = function(path, ...args) {
      if (String(path).endsWith('/styles.css')) throw new Error('missing asset');
      return read.call(this, path, ...args);
    }; syncBuiltinESMExports();
    const { startSandboxServer } = await import('./dist/examples/agent-sandbox/src/server.js');
    try { const server = await startSandboxServer({ mode: 'scripted', port: 29890 }); await server.close(); process.stdout.write('unexpected-success'); }
    catch { process.stdout.write('asset-failed'); }`;
  const child = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 2000 });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  assert.match(child.stdout, /asset-failed/);
});
