/**
 * 验证真实启动脚本通过安全日志提供地址、模式与自动回退状态。
 * 子进程只启动本地服务，不发起模型调用或访问外部网络。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createSafeLogSink } from '../../../examples/agent-sandbox/src/safe-log.js';

/** 测试凭据哨兵绝不能进入日志。 */
const secret = 'private-startup-key-sentinel';

/**
 * 启动指定模式并读取 stderr 中的唯一启动事件。
 * @param args - 受控启动参数
 * @param key - 替换可能存在的本机凭据
 * @param port - 真实监听端口
 * @returns 已解析的启动记录
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function start(args: string[], key: string, port: number): Record<string, unknown> {
  const env = { ...process.env, IAR_SANDBOX_PORT: String(port), IAR_LLM_API_KEY: key, IAR_MODEL_API_KEY: 'CHANGE_ME',
    IAR_LLM_BASE_URL: 'http://127.0.0.1:1' };
  // 启动包含 node:sqlite 工作线程初始化；超时只保护测试不挂死，不是服务 SLA。
  const child = spawnSync(process.execPath, ['scripts/run-agent-sandbox.mjs', ...args], { encoding: 'utf8', env, timeout: 2000 });
  assert.equal((child.error as NodeJS.ErrnoException | undefined)?.code, 'ETIMEDOUT', child.stderr);
  assert.equal(child.stdout, '');
  assert.ok(child.stderr.length > 0, '启动后应有安全启动状态');
  assert.ok(!child.stderr.includes(secret));
  return JSON.parse(child.stderr) as Record<string, unknown>;
}

/**
 * 未配置密钥时自动回退必须明确可见，地址使用实际监听端口。
 * 使用占位符覆盖本机环境和 .env，避免真实凭据影响测试。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('自动回退启动记录地址、实际模式和回退状态', () => {
  const port = 22000 + process.pid % 15000;
  assert.deepEqual(start([], 'CHANGE_ME', port),
    { level: 'info', event: 'sandbox.start', host: '127.0.0.1', port, mode: 'scripted', selection: 'fallback' });
});

/**
 * 显式离线模式不是自动回退，敏感密钥不得出现在日志。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('显式离线启动记录实际模式而不误报回退', () => {
  const port = 22001 + process.pid % 15000;
  assert.deepEqual(start(['--brain', 'scripted'], secret, port),
    { level: 'info', event: 'sandbox.start', host: '127.0.0.1', port, mode: 'scripted', selection: 'explicit' });
});

/**
 * 配置密钥时启动真实模式但不发送请求，验证实际模式及脱敏。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('自动选择真实模式时日志不泄漏凭据', () => {
  const port = 22002 + process.pid % 15000;
  assert.deepEqual(start([], secret, port),
    { level: 'info', event: 'sandbox.start', host: '127.0.0.1', port, mode: 'brain', selection: 'configured' });
});

/**
 * 启动失败只输出固定分类，不输出原始异常或环境密钥。
 * 非法端口令本地监听失败，不访问真实模型服务。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('启动失败只输出安全固定分类', () => {
  const env = { ...process.env, IAR_SANDBOX_PORT: '65536', IAR_LLM_API_KEY: secret, IAR_MODEL_API_KEY: 'CHANGE_ME' };
  const child = spawnSync(process.execPath, ['scripts/run-agent-sandbox.mjs', '--brain', 'scripted'], { encoding: 'utf8', env, timeout: 2000 });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  assert.doesNotMatch(child.stderr, /RangeError|ERR_SOCKET_BAD_PORT|private-startup-key-sentinel/);
  assert.deepEqual(JSON.parse(child.stderr), { level: 'warn', event: 'sandbox.start_failed', outcome: 'startup_failed' });
});

/**
 * 端口占用必须输出可操作的固定提示，而不是只返回无法定位的通用失败。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
test('端口占用输出 port_in_use 及恢复提示', async () => {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', () => resolve());
  });
  const address = blocker.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const env = { ...process.env, IAR_SANDBOX_PORT: String(address.port), IAR_LLM_API_KEY: 'CHANGE_ME', IAR_MODEL_API_KEY: 'CHANGE_ME' };
    const child = spawnSync(process.execPath, ['scripts/run-agent-sandbox.mjs', '--brain', 'scripted'], { encoding: 'utf8', env, timeout: 2000 });
    assert.equal(child.status, 1);
    const logLine = child.stderr.split('\n').find((line) => line.startsWith('{'));
    assert.ok(logLine);
    assert.deepEqual(JSON.parse(logLine), { level: 'warn', event: 'sandbox.start_failed', outcome: 'port_in_use' });
    assert.match(child.stderr, /端口.*占用|IAR_SANDBOX_PORT/);
    assert.doesNotMatch(child.stderr, /EADDRINUSE|private|Error:/);
  } finally {
    await new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
  }
});

/**
 * 启动参数错误必须经过同一安全日志边界并保持非零退出。
 * @param args - 故意触发错误的启动参数
 * @param outcome - 期望的固定错误分类
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function checkArgumentFailure(args: string[], outcome: string): void {
  const env = { ...process.env, IAR_LLM_API_KEY: 'CHANGE_ME', IAR_MODEL_API_KEY: 'CHANGE_ME' };
  const child = spawnSync(process.execPath, ['scripts/run-agent-sandbox.mjs', ...args], { encoding: 'utf8', env, timeout: 2000 });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  assert.ok(!child.stderr.includes(secret));
  assert.match(child.stderr, /^\{/);
  assert.deepEqual(JSON.parse(child.stderr), { level: 'warn', event: 'sandbox.start_failed', outcome });
}

/** 非法模式包含敏感哨兵时也只能输出固定错误枚举。 */
test('非法模式通过安全日志拒绝且不泄漏输入', () => { checkArgumentFailure(['--brain', secret], 'invalid_mode'); });

/** 显式 real 缺少密钥必须输出安全枚举并保持非零退出。 */
test('真实模式缺密钥通过安全日志拒绝', () => { checkArgumentFailure(['--brain', 'real'], 'missing_api_key'); });

/**
 * 配置文件读取失败发生在监听前，也不能泄露原始文件系统异常。
 * 使用独立临时目录模拟不可读取的配置文件路径。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('启动前配置读取失败不输出自由错误', () => {
  const directory = mkdtempSync(join(tmpdir(), 'iar-safe-startup-'));
  const dotEnv = join(directory, '.env');
  mkdirSync(dotEnv);
  try {
    const child = spawnSync(process.execPath, [resolve('scripts/run-agent-sandbox.mjs')],
      { cwd: directory, encoding: 'utf8', timeout: 2000 });
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.deepEqual(JSON.parse(child.stderr), { level: 'warn', event: 'sandbox.start_failed', outcome: 'startup_failed' });
  } finally { rmdirSync(dotEnv); rmdirSync(directory); }
});

/**
 * 启动字段必须被统一白名单校验，越界端口和自由文本被删除。
 * 同时检查合法边界值，防止仅靠禁用字段使脱敏断言通过。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('启动字段只允许固定枚举和有效端口', async () => {
  const output: string[] = [];
  const sink = createSafeLogSink((buffer, done) => { output.push(buffer.toString()); done(null, buffer.length); }, 2);
  sink.write({ event: 'sandbox.start', host: '127.0.0.1', port: 65535, mode: 'brain', selection: 'explicit' });
  sink.write({ event: 'sandbox.start', host: secret, port: 65536, mode: secret, selection: secret });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(output[0]!), { event: 'sandbox.start', host: '127.0.0.1', port: 65535, mode: 'brain', selection: 'explicit' });
  assert.deepEqual(JSON.parse(output[1]!), { event: 'sandbox.start' });
  assert.ok(!output.join('').includes(secret));
});

/**
 * 通过进程内确定性服务故障验证脚本关闭异常的输出边界。
 * 动态模块保留真实启动脚本逻辑，仅替换服务和配置依赖。
 * 原始关闭错误含敏感哨兵，不得由未处理拒绝写到 stderr。
 * 子进程发送真实 SIGTERM，故障由测试服务在关闭时抛出。
 * 日志写入仍经实际白名单接收器，不使用外部模型或网络。
 * 使用有限超时防止失败的进程一直占用测试资源。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('脚本关闭失败输出固定分类而不泄漏原始错误', () => {
  const logUrl = pathToFileURL(resolve('dist/examples/agent-sandbox/src/safe-log.js')).href;
  const source = readFileSync('scripts/run-agent-sandbox.mjs', 'utf8')
    .replace("import { loadDotEnv } from '../dist/examples/agent-sandbox/src/env.js';", 'const loadDotEnv = () => {};')
    .replace("import { startSandboxServer } from '../dist/examples/agent-sandbox/src/server.js';",
      "const startSandboxServer = async () => ({port: 1, mode: 'scripted', close: async () => {throw new Error('private-shutdown-error')}});")
    .replace("'../dist/examples/agent-sandbox/src/safe-log.js'", JSON.stringify(logUrl));
  const encoded = Buffer.from(source).toString('base64');
  const script = `setInterval(()=>{},1000); setTimeout(()=>process.kill(process.pid,'SIGTERM'),200); await import('data:text/javascript;base64,${encoded}');`;
  const env = { ...process.env, IAR_LLM_API_KEY: 'CHANGE_ME', IAR_MODEL_API_KEY: 'CHANGE_ME' };
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env, timeout: 2000 });
  assert.equal(child.status, 1);
  assert.doesNotMatch(child.stderr, /private-shutdown-error/);
  const logs = child.stderr.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(logs.some((entry) => entry.event === 'sandbox.shutdown_failed' && entry.outcome === 'shutdown_failed'));
});
