/**
 * 验证离线启动脚本接收 SIGTERM 后正常退出并释放监听端口。
 * 就绪检查使用本地 TCP，不依赖尽力投递的启动日志。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import test from 'node:test';

/**
 * 从系统获取临时可用的本地监听端口并释放预留。
 * @returns 本地端口
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function reservePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

/**
 * 尝试连接本地服务，不泄露或依赖日志输出。
 * @param port - 测试端口
 * @returns 是否连接成功
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.setTimeout(100, () => { socket.destroy(); resolve(false); });
  });
}

/**
 * 有界等待本地服务真正开始监听。
 * @param port - 测试端口
 * @returns 服务就绪后结束
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function waitReady(port: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await canConnect(port)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('本地服务未在期限内就绪');
}

/**
 * 验证进程退出后可以立即重新监听原端口。
 * @param port - 被测端口
 * @returns 重新监听并关闭后结束
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function assertReleased(port: number): Promise<void> {
  const server = createServer();
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

/**
 * 显式发送终止信号，验证正常退出码和端口可重新绑定。
 * stdout 不得出现启动消息，测试不要求启动日志一定被投递。
 * 失败时只终止本测试启动的子进程，避免残留监听器。
 * @param signal - 要发送的进程终止信号
 * @returns 验证结束
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkShutdown(signal: NodeJS.Signals): Promise<void> {
  const port = await reservePort();
  const env = { ...process.env, IAR_SANDBOX_PORT: String(port), IAR_LLM_API_KEY: 'CHANGE_ME', IAR_MODEL_API_KEY: 'CHANGE_ME' };
  const child = spawn(process.execPath, ['scripts/run-agent-sandbox.mjs', '--brain', 'scripted'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  // 等待流关闭，确保 stdout 检查覆盖子进程退出前的所有输出。
  const exited = once(child, 'close', { signal: AbortSignal.timeout(5000) });
  try {
    await waitReady(port);
    assert.equal(child.kill(signal), true);
    assert.deepEqual(await exited, [0, null]);
    assert.equal(stdout, '');
    await assertReleased(port);
  } finally {
    // 只清理当前测试创建且仍存活的进程。
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

/** SIGTERM 关闭真实进程并释放端口。 */
test('SIGTERM 正常退出并释放本地监听端口', { timeout: 6000 }, () => checkShutdown('SIGTERM'));

/** SIGINT 与 SIGTERM 使用同一安全关闭路径。 */
test('SIGINT 正常退出并释放本地监听端口', { timeout: 6000 }, () => checkShutdown('SIGINT'));
