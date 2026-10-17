/**
 * 启动 IAR agent sandbox 演示服务。
 *
 * 支持 --brain real|scripted 选择大脑模式；缺省在检测到 IAR_LLM_API_KEY 或
 * IAR_MODEL_API_KEY（含仓库根目录 .env 文件中的配置）时使用真实 LLM（real），
 * 否则回退到离线假大脑（scripted）。
 * 演示入口只使用构建产物，npm run demo:sandbox 会先生成 dist 再执行本文件。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { loadDotEnv } from '../dist/examples/agent-sandbox/src/env.js';
import { startSandboxServer } from '../dist/examples/agent-sandbox/src/server.js';

// 模式判定依赖环境变量，必须先补齐 .env 再决定 real/scripted。
loadDotEnv();

const args = process.argv.slice(2);
const brainFlagIndex = args.indexOf('--brain');
const forcedMode = brainFlagIndex === -1 ? undefined : args[brainFlagIndex + 1];
if (forcedMode !== undefined && forcedMode !== 'real' && forcedMode !== 'scripted') {
  console.error(`未知的大脑模式: ${forcedMode}，只允许 real 或 scripted。`);
  process.exit(1);
}
const hasApiKey = Boolean(process.env.IAR_LLM_API_KEY ?? process.env.IAR_MODEL_API_KEY);
const mode = forcedMode ?? (hasApiKey ? 'real' : 'scripted');
if (mode === 'real' && !hasApiKey) {
  console.error('brain real 模式需要环境变量 IAR_LLM_API_KEY（或 IAR_MODEL_API_KEY），可写入仓库根目录 .env，或未配置时改用 --brain scripted。');
  process.exit(1);
}

const server = await startSandboxServer({ mode });
console.log('按 Ctrl+C 停止服务。');

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
