/**
 * 提供 sandbox 的 .env 环境变量加载。
 *
 * 启动时读取仓库根目录的 .env 文件（若存在），把 KEY=VALUE 行注入
 * process.env；已存在的环境变量优先，不被文件覆盖。密钥只从环境变量
 * 读取，不写入任何配置文件。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** .env 文件的最大字节数，避免误读超大文件。 */
const MAX_DOTENV_BYTES = 64 * 1024;

/**
 * 从仓库根目录 .env 加载环境变量（幂等，不覆盖已存在的变量）。
 *
 * 解析规则：跳过空行与 # 注释行；KEY=VALUE 两侧空白去除；
 * 值首尾成对的单双引号会被去除；其余行原样忽略。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function loadDotEnv(): void {
  const path = join(process.cwd(), '.env');
  if (!existsSync(path)) return;
  const content = readFileSync(path, { encoding: 'utf8', flag: 'r' }).slice(0, MAX_DOTENV_BYTES);
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = unquote(trimmed.slice(separator + 1).trim());
    // 真实环境变量优先，文件只补缺省值，保证部署环境可以覆盖本地 .env。
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * 去除值首尾成对的引号。
 *
 * @param value - 原始值
 * @returns 去引号后的值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
  }
  return value;
}
