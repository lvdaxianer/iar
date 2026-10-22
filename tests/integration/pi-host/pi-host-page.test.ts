/** Pi host 演示页装配与条目信封校验回归。
 * 页面与 IAR Agent Sandbox 共用 styles.css 与安全 Markdown 片段，
 * 这里验证共用在装配结果中真实生效，以及协议适配片段保留条目校验边界。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { loadPiHostPage } from '../../../examples/agent-sandbox/src/page-template.js';

const PAGE_DIR = join(process.cwd(), 'examples/agent-sandbox/src/pi-host/web');
const SHARED_DIR = join(process.cwd(), 'examples/agent-sandbox/web');

/* 模板必须带独立占位符，且与沙箱页占位符不混用；
 * 缺失或重复占位符由装配器拒绝服务启动。 */
test('Pi host 页面模板占位符独立且唯一', () => {
  const template = readFileSync(join(PAGE_DIR, 'index.html'), 'utf8');
  assert.match(template, /<!-- IAR_PI_HOST_STYLES -->/);
  assert.match(template, /<!-- IAR_PI_HOST_SCRIPT -->/);
  assert.match(template, /id="clearSessionBtn"/);
  assert.doesNotMatch(template, /IAR_SANDBOX_(?:STYLES|SCRIPT)/);
});

/* 与沙箱页同一套视觉：样式必须是同一份 styles.css，
 * 禁止把 Pi host 页面写成另一套独立视觉。 */
test('Pi host 页面复用沙箱同源样式与 Markdown 片段', () => {
  const page = loadPiHostPage();
  const styles = readFileSync(join(SHARED_DIR, 'styles.css'), 'utf8');
  const markdown = readFileSync(join(SHARED_DIR, 'markdown.fragment.js'), 'utf8');
  assert.ok(page.includes(`<style>${styles}</style>`));
  assert.ok(page.includes(markdown));
  assert.ok(page.includes('function renderMarkdown(src)'));
  assert.ok(page.includes('function renderPiHostEntry(entry)'));
});

/* 首页响应必须自包含：无残留标记、无外链脚本样式，
 * NUL 字节数量与沙箱页一致，防止拼接损坏共用资源。 */
test('Pi host 页面拼装为自包含响应并保留共用资源字节', () => {
  const page = loadPiHostPage();
  assert.doesNotMatch(page, /IAR_PI_HOST_(?:STYLES|SCRIPT)/);
  assert.doesNotMatch(page, /<script[^>]+src=|<link[^>]+stylesheet/);
  assert.equal([...page].filter((character) => character === '\0').length, 4);
  assert.ok(page.includes('id="messages"'));
  assert.ok(page.includes('id="flowList"'));
  assert.ok(page.includes('id="routeReplySource"'));
  assert.ok(page.includes('id="routeExpected"'));
  assert.ok(page.includes('id="routeActual"'));
  assert.ok(page.includes('\'use strict\';'));
});

/* 保留 9e26f1f 的条目校验边界：解析失败、非 iar-bridge 类型、
 * 非对象 data 或缺失 content 的事件一律忽略，避免空卡片或污染会话。 */
test('Pi host 协议适配片段校验 IAR entry 信封后再渲染', () => {
  const adapter = readFileSync(join(PAGE_DIR, 'pi-host.fragment.js'), 'utf8');
  assert.match(adapter, /function renderPiHostEntry\(entry\)/);
  assert.match(adapter, /'data' in entry/);
  assert.match(adapter, /try \{ entry = JSON\.parse\(event\.data\); \} catch \(err\) \{ return; \}/);
  assert.match(adapter, /entry\.customType !== 'iar-bridge'/);
  assert.match(adapter, /typeof data\.content !== 'string'/);
  assert.match(adapter, /PI_HOST_REPLY_SOURCE_META/);
  assert.match(adapter, /routeReplySource/);
  assert.match(adapter, /routeExpected/);
  assert.match(adapter, /routeActual/);
  assert.match(adapter, /data\.replySource/);
  assert.match(adapter, /renderPiHostEntry\(entry\)/);
});

/* 历史回放依赖原始 Markdown：渲染后的 textContent 会丢失换行与标记，
 * 快照必须发生在 innerHTML 替换之前。 */
test('Pi host 气泡历史在 Markdown 渲染前快照原始文本', () => {
  const adapter = readFileSync(join(PAGE_DIR, 'pi-host.fragment.js'), 'utf8');
  const finalize = /function finalizePiHostBubble\([\s\S]*?\n  \}/.exec(adapter)?.[0] ?? '';
  const snapshot = finalize.indexOf('var rawText = bubble.textEl.textContent;');
  const render = finalize.indexOf('bubble.textEl.innerHTML = renderMarkdown(rawText);');
  assert.ok(snapshot >= 0 && render > snapshot, 'rawText 快照必须先于 renderMarkdown');
  assert.match(finalize, /recordPiHostConversation\('bot', rawText/);
});

/* Pi host 的 timing 事件先到时，当前 entry/回复必须带上同一 trace；
 * 完整 trace 另在右侧面板展示，避免卡片被长标识撑破。 */
test('Pi host 回复 meta 与 Timing 面板展示服务端耗时和 traceId', () => {
  const adapter = readFileSync(join(PAGE_DIR, 'pi-host.fragment.js'), 'utf8');
  const page = readFileSync(join(PAGE_DIR, 'index.html'), 'utf8');
  assert.match(adapter, /piHostPendingTiming/);
  assert.match(adapter, /durationMs/);
  assert.match(adapter, /traceId/);
  assert.match(adapter, /title/);
  assert.match(page, /id="timingTraceId"/);
});

/* 与沙箱页同一展示契约：消息追加、条目渲染、确认卡片与流式气泡都要有界。 */
test('Pi host 页面交互入口按职责拆分且有界', () => {
  const adapter = readFileSync(join(PAGE_DIR, 'pi-host.fragment.js'), 'utf8');
  for (const name of ['appendMsg', 'renderPiHostEntry', 'showPiHostConfirmBox', 'finalizePiHostBubble', 'clearPiHostSession']) {
    const method = new RegExp(`  function ${name}\\([\\s\\S]*?\\n  \\}`).exec(adapter);
    assert.ok(method, `${name} 应存在`);
    assert.ok(method[0].split('\n').length <= 20, `${name} 为 ${method[0].split('\n').length} 行`);
  }
  assert.match(adapter, /clearSessionBtn'\)\.onclick = clearPiHostSession/);
});
