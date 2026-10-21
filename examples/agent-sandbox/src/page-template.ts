/**
 * 将固定的页面源片段拼装为自包含 HTML。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 片段按原页面词法作用域顺序拼接，不作为独立脚本执行。 */
const SCRIPT_PARTS = ['session.fragment.js', 'markdown.fragment.js', 'markdown-lines.fragment.js', 'timing.fragment.js', 'interaction.fragment.js', 'stream.fragment.js', 'sessions.fragment.js', 'controls.fragment.js'];
/** Pi host 演示页与沙箱页共用的安全 Markdown 片段，顺序在协议适配片段之前。 */
const PI_HOST_SHARED_PARTS = ['markdown.fragment.js', 'markdown-lines.fragment.js', 'timing.fragment.js'];
/** 每个占位符仅允许在模板中出现一次。 */
const STYLE_MARKER = '<!-- IAR_SANDBOX_STYLES -->';
const SCRIPT_MARKER = '<!-- IAR_SANDBOX_SCRIPT -->';
/** Pi host 演示页模板的独立占位符，避免与沙箱模板混用。 */
const PI_HOST_STYLE_MARKER = '<!-- IAR_PI_HOST_STYLES -->';
const PI_HOST_SCRIPT_MARKER = '<!-- IAR_PI_HOST_SCRIPT -->';
/** Pi host 演示页自有资源目录；样式与 Markdown 片段仍与沙箱页同源。 */
const PI_HOST_WEB_DIR = join('examples', 'agent-sandbox', 'src', 'pi-host', 'web');

/**
 * 启动时读取固定路径，任何缺失或模板错误均阻止服务启动。
 * @returns 可直接响应的自包含 HTML
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function loadSandboxPage(): string {
  const directory = join(process.cwd(), 'examples', 'agent-sandbox', 'web');
  const template = readFileSync(join(directory, 'index.html'), 'utf8');
  const styles = readFileSync(join(directory, 'styles.css'), 'utf8');
  const script = SCRIPT_PARTS.map((part) => readFileSync(join(directory, part), 'utf8')).join('');
  return replaceMarker(replaceMarker(template, STYLE_MARKER, `<style>${styles}</style>`), SCRIPT_MARKER, `<script>${script}</script>`);
}

/**
 * 启动时拼装 Pi host 演示页：模板来自 src/pi-host/web，
 * 样式与 Markdown 片段与沙箱页同源，仅协议适配片段为 Pi host 独有。
 * 脚本包在严格模式块作用域中，片段共享词法作用域而不污染全局。
 * @returns 可直接响应的自包含 HTML
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
export function loadPiHostPage(): string {
  const sharedDir = join(process.cwd(), 'examples', 'agent-sandbox', 'web');
  const pageDir = join(process.cwd(), PI_HOST_WEB_DIR);
  const template = readFileSync(join(pageDir, 'index.html'), 'utf8');
  const styles = readFileSync(join(sharedDir, 'styles.css'), 'utf8');
  const shared = PI_HOST_SHARED_PARTS.map((part) => readFileSync(join(sharedDir, part), 'utf8')).join('');
  const adapter = readFileSync(join(pageDir, 'pi-host.fragment.js'), 'utf8');
  const script = `'use strict';\n{\n${shared}${adapter}}\n`;
  const html = replaceMarker(replaceMarker(template, PI_HOST_STYLE_MARKER, `<style>${styles}</style>`), PI_HOST_SCRIPT_MARKER, `<script>${script}</script>`);
  if (!html.includes('id="messages"')) throw new Error('Pi host 演示页面模板无效。');
  return html;
}

/**
 * 替换唯一占位符，避免不完整页面静默启动。
 * @param template - 页面模板
 * @param marker - 必须唯一存在的占位符
 * @param content - 要嵌入的内容
 * @returns 完成替换的页面
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function replaceMarker(template: string, marker: string, content: string): string {
  const first = template.indexOf(marker);
  // 缺失或重复标记说明资源部署不完整。
  if (first < 0 || first !== template.lastIndexOf(marker)) throw new Error('Invalid sandbox page template');
  return template.slice(0, first) + content + template.slice(first + marker.length);
}
