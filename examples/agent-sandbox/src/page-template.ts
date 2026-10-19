/**
 * 将固定的页面源片段拼装为自包含 HTML。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 片段按原页面词法作用域顺序拼接，不作为独立脚本执行。 */
const SCRIPT_PARTS = ['session.fragment.js', 'markdown.fragment.js', 'markdown-lines.fragment.js', 'interaction.fragment.js', 'stream.fragment.js', 'controls.fragment.js'];
/** 每个占位符仅允许在模板中出现一次。 */
const STYLE_MARKER = '<!-- IAR_SANDBOX_STYLES -->';
const SCRIPT_MARKER = '<!-- IAR_SANDBOX_SCRIPT -->';

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
