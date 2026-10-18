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
import { writeSafeLog } from '../dist/examples/agent-sandbox/src/safe-log.js';

/** 启动失败时给予异步日志的有限调度时间，单位毫秒。 */
const STARTUP_LOG_GRACE_MS = 100;

/**
 * 输出固定启动失败分类，不记录异常内容。
 * @param {string} outcome - 受白名单控制的失败分类
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function reportStartupFailure(outcome = 'startup_failed') {
  writeSafeLog({ level: 'warn', event: 'sandbox.start_failed', outcome });
  process.exitCode = 1;
}

/**
 * 给予安全日志有界异步输出机会，然后以失败状态退出。
 * @param {string} outcome - 受白名单控制的失败分类
 * @returns {Promise<never>} 进程退出
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function exitStartupFailure(outcome = 'startup_failed') {
  reportStartupFailure(outcome);
  await new Promise((resolve) => setTimeout(resolve, STARTUP_LOG_GRACE_MS));
  process.exit(1);
}

// 模式判定依赖环境变量，读取失败也不得泄露文件系统异常。
try { loadDotEnv(); } catch {
  await exitStartupFailure();
}

const args = process.argv.slice(2);
const brainFlagIndex = args.indexOf('--brain');
// 缺省模式继续沿用自动选择；给出的模式只接受固定枚举。
const forcedMode = brainFlagIndex === -1 ? undefined : args[brainFlagIndex + 1];
if (forcedMode !== undefined && forcedMode !== 'real' && forcedMode !== 'scripted') {
  // 不记录未通过校验的模式文本。
  await exitStartupFailure('invalid_mode');
}
// 占位符 CHANGE_ME 与空白视为未配置，避免误判成 real 模式后调用必然失败。
function configured(value) {
  const trimmed = value?.trim();
  return trimmed && trimmed !== 'CHANGE_ME' ? trimmed : undefined;
}
const hasApiKey = Boolean(configured(process.env.IAR_LLM_API_KEY) ?? configured(process.env.IAR_MODEL_API_KEY));
// 自动选择仅检查是否配置密钥，不输出密钥内容。
const mode = forcedMode ?? (hasApiKey ? 'real' : 'scripted');
if (mode === 'real' && !hasApiKey) {
  // 缺少凭据时只输出固定分类。
  await exitStartupFailure('missing_api_key');
}
const serverStarting = startSandboxServer({ mode: mode === 'real' ? 'brain' : 'scripted' }).catch(() => {
  // 启动异常可能包含私有路径和配置，只输出固定分类。
  reportStartupFailure();
  // 给异步日志有限的输出机会，避免未完成资源让启动失败进程永久存活。
  setTimeout(() => process.exit(1), STARTUP_LOG_GRACE_MS);
  return undefined;
});

// 启动进行中先注册信号处理器，避免监听就绪早于关闭处理器。
const shutdown = async () => {
  const server = await serverStarting;
  // 信号发生在启动期间时，等待启动完成后再关闭真实服务。
  try { if (server) await server.close(); } catch {
    // 关闭异常可能包含敏感信息，只输出受控分类后失败退出。
    // 定时等待不保证接收器一定成功投递。
    writeSafeLog({ level: 'warn', event: 'sandbox.shutdown_failed', outcome: 'shutdown_failed' });
    await new Promise((resolve) => setTimeout(resolve, STARTUP_LOG_GRACE_MS));
    process.exit(1);
  }
  process.exit(server ? 0 : 1);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const server = await serverStarting;
if (server) {
  // 仅在监听成功后发出启动记录，失败路径不伪报就绪。
  // 模式与端口来自成功启动的服务，回退状态由受控枚举标识。
  const selection = forcedMode ? 'explicit' : hasApiKey ? 'configured' : 'fallback';
  writeSafeLog({ level: 'info', event: 'sandbox.start', host: '127.0.0.1', port: server.port, mode: server.mode, selection });
}
