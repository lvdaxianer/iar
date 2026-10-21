/**
 * 启动 “Pi 宿主 + IAR 前置意图路由” 演示：sandbox（bridge 服务端，:8787）
 * 与 Pi 宿主演示页（:8788）同进程运行。
 *
 * 支持 --brain real|scripted 选择大脑模式；缺省在检测到 IAR_LLM_API_KEY 或
 * IAR_MODEL_API_KEY（含仓库根目录 .env 文件中的配置）时使用真实 LLM（real），
 * 否则回退到离线假大脑（scripted）。演示入口只使用构建产物。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
import { loadDotEnv } from '../dist/examples/agent-sandbox/src/env.js';
import { startPiHostServer } from '../dist/examples/agent-sandbox/src/pi-host/pi-host-server.js';
import { startSandboxServer } from '../dist/examples/agent-sandbox/src/server.js';
import { writeSafeLog } from '../dist/examples/agent-sandbox/src/safe-log.js';

/** 启动失败时给予异步日志的有限调度时间，单位毫秒。 */
const STARTUP_LOG_GRACE_MS = 100;

/** 输出固定启动失败分类，不记录异常内容。 */
function reportStartupFailure(outcome = 'startup_failed') {
  writeSafeLog({ level: 'warn', event: 'sandbox.start_failed', outcome });
  if (outcome === 'port_in_use') {
    process.stderr.write('演示启动失败：端口已被占用。请结束已有进程，或设置 IAR_SANDBOX_PORT / IAR_PI_HOST_PORT 使用其他端口。\n');
  }
  process.exitCode = 1;
}

/** 将启动异常收敛为安全的固定分类。 */
function classifyStartupFailure(error) {
  if (error && typeof error === 'object' && error.code === 'EADDRINUSE') return 'port_in_use';
  return 'startup_failed';
}

/** 给予安全日志有界异步输出机会，然后以失败状态退出。 */
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
const forcedMode = brainFlagIndex === -1 ? undefined : args[brainFlagIndex + 1];
if (forcedMode !== undefined && forcedMode !== 'real' && forcedMode !== 'scripted') {
  await exitStartupFailure('invalid_mode');
}
// 占位符 CHANGE_ME 与空白视为未配置，避免误判成 real 模式后调用必然失败。
function configured(value) {
  const trimmed = value?.trim();
  return trimmed && trimmed !== 'CHANGE_ME' ? trimmed : undefined;
}
const hasApiKey = Boolean(configured(process.env.IAR_LLM_API_KEY) ?? configured(process.env.IAR_MODEL_API_KEY));
const mode = forcedMode ?? (hasApiKey ? 'real' : 'scripted');
if (mode === 'real' && !hasApiKey) {
  await exitStartupFailure('missing_api_key');
}

/** 依次启动 bridge 服务端与 Pi 宿主演示页；任一步失败即收敛并退出。
 * 缺省端口被占用时回退为独立演示页模式，复用已在运行的 bridge。 */
async function startDemo() {
  const sandboxPortExplicit = process.env.IAR_SANDBOX_PORT !== undefined && process.env.IAR_SANDBOX_PORT.length > 0;
  try {
    const sandbox = await startSandboxServer({ mode: mode === 'real' ? 'brain' : 'scripted' });
    try {
      const piHost = await startPiHostServer({ mode: mode === 'real' ? 'brain' : 'scripted', bridgeUrl: `http://127.0.0.1:${String(sandbox.port)}` });
      return { sandbox, piHost };
    } catch (error) {
      await sandbox.close().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    // 仅缺省端口被占用才回退；显式端口冲突按启动失败处理。
    if (!sandboxPortExplicit && error && typeof error === 'object' && error.code === 'EADDRINUSE') {
      process.stderr.write('8787 已有服务在运行，回退为独立演示页模式，复用现有 bridge。\n');
      const piHost = await startPiHostServer({ mode: mode === 'real' ? 'brain' : 'scripted', bridgeUrl: process.env.IAR_PI_BRIDGE_URL ?? 'http://127.0.0.1:8787' });
      return { sandbox: undefined, piHost };
    }
    throw error;
  }
}

const demoStarting = startDemo().catch((error) => {
  reportStartupFailure(classifyStartupFailure(error));
  setTimeout(() => process.exit(1), STARTUP_LOG_GRACE_MS);
  return undefined;
});

const shutdown = async () => {
  const demo = await demoStarting;
  try {
    if (demo) {
      await demo.piHost.close();
      await demo.sandbox?.close();
    }
  } catch {
    writeSafeLog({ level: 'warn', event: 'sandbox.shutdown_failed', outcome: 'shutdown_failed' });
    await new Promise((resolve) => setTimeout(resolve, STARTUP_LOG_GRACE_MS));
    process.exit(1);
  }
  process.exit(demo ? 0 : 1);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const demo = await demoStarting;
if (demo) {
  const selection = forcedMode ? 'explicit' : hasApiKey ? 'configured' : 'fallback';
  if (demo.sandbox) writeSafeLog({ level: 'info', event: 'sandbox.start', host: '127.0.0.1', port: demo.sandbox.port, mode: demo.sandbox.mode, selection });
  writeSafeLog({ level: 'info', event: 'sandbox.pi_host_start', host: '127.0.0.1', port: demo.piHost.port, mode: demo.piHost.mode, selection });
  const bridgeHint = demo.sandbox ? `http://127.0.0.1:${String(demo.sandbox.port)}` : '(复用已有 bridge)';
  process.stderr.write(`Pi 宿主演示页: http://127.0.0.1:${String(demo.piHost.port)}  bridge: ${bridgeHint}\n`);
}
