/**
 * 验证安全接收器可观测故障和专用输出边界。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import * as logging from '../../../examples/agent-sandbox/src/safe-log.js';

/**
 * 让异步写入调度运行一个事件循环。
 * @returns 下一次调度完成
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function tick(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }
/** 使用固定记录防止测试引入自由文本。 */
const record = { level: 'warn', event: 'model.http' };

/**
 * 使用反射检查只读状态接口，保证 RED 不是编译失败。
 * @param sink - 被测有界接收器
 * @returns 安全计数快照
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function status(sink: object): Record<string, unknown> {
  const getStatus: unknown = Reflect.get(sink, 'getStatus');
  assert.equal(typeof getStatus, 'function', '应提供独立只读状态接口');
  return Reflect.apply(getStatus as (...args: never[]) => Record<string, unknown>, sink, []);
}

/**
 * 验证迟到和重复回调不会与新在途写入发生竞争。
 * @param sink - 卡住的接收器
 * @param callbacks - 模拟写入回调列表
 * @returns 恢复验证结束
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkRecovery(sink: ReturnType<typeof logging.createSafeLogSink>, callbacks: Array<(error: Error | null, written: number) => void>): Promise<void> {
  callbacks[0]!(null, 1);
  sink.write(record);
  await tick();
  callbacks[0]!(null, 1);
  assert.equal(callbacks.length, 2);
  assert.equal(status(sink).inFlight, true);
  callbacks[1]!(new Error('private-error'), 0);
  assert.equal(status(sink).failures, 2);
  assert.equal(status(sink).stalled, false);
}

/**
 * 永不回调时记录饱和丢弃与卡住，且不能发起并发重试。
 * 迟到回调恢复后，重复回调不能影响新写入。
 * 状态快照不可变且不包含原始异常或记录正文。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('卡住、丢弃、迟到及重复回调状态可安全观测', async () => {
  const callbacks: Array<(error: Error | null, written: number) => void> = [];
  const sink = logging.createSafeLogSink((_buffer, done) => { callbacks.push(done); }, 1, 10);
  sink.write(record);
  await tick();
  sink.write(record);
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  sink.write(record);
  const stalled = status(sink);
  assert.deepEqual(stalled, { dropped: 3, failures: 1, stalls: 1, stalled: true, queued: 0, inFlight: true });
  assert.ok(Object.isFrozen(stalled));
  assert.equal(callbacks.length, 1);
  await checkRecovery(sink, callbacks);
});

/**
 * 公共状态与注入接口必须存在，不经过日志输出通道。
 * 反射保证尚未实现时表现为行为失败。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('公开进程级只读状态及专用异步输出注入接口', () => {
  assert.equal(typeof Reflect.get(logging, 'getSafeLogSinkStatus'), 'function');
  assert.equal(typeof Reflect.get(logging, 'configureSafeLogWriter'), 'function');
});

/**
 * 有界队列填满时必须立即累计丢弃，而不是等待写入完成。
 * 状态接口不调用接收器，因此卡住时仍可查询。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('队列满和写失败均计入安全状态', async () => {
  const sink = logging.createSafeLogSink((_buffer, done) => { done(new Error('private-error'), 0); }, 1);
  sink.write(record);
  sink.write(record);
  assert.equal(status(sink).dropped, 1);
  await tick();
  assert.deepEqual(status(sink), { dropped: 2, failures: 1, stalls: 0, stalled: false, queued: 0, inFlight: false });
});

/**
 * 专用输出注入后仍经过字段白名单且不得同步写入。
 * 测试使用独立进程避免替换当前测试夹具的接收器。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('宿主可注入专用异步输出并保留安全过滤', () => {
  const script = `import {configureSafeLogWriter,writeSafeLog} from './dist/examples/agent-sandbox/src/safe-log.js';
    configureSafeLogWriter((buffer,done)=>{process.stderr.write(buffer);done(null,buffer.length)});
    writeSafeLog({level:'warn',event:'model.http',secret:'private-sentinel'}); process.stdout.write('protocol\\n');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, IAR_LOG_FORMAT: 'json' } });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, 'protocol\n');
  assert.deepEqual(JSON.parse(child.stderr), record);
});

/**
 * 真实进程级状态在接收器永久不回调时仍可读取。
 * 在途写入期间不能重新配置，防止旧写入与新写入并发。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('进程级卡住状态可读取且不能并发切换输出', () => {
  const script = `import {configureSafeLogWriter,getSafeLogSinkStatus,writeSafeLog} from './dist/examples/agent-sandbox/src/safe-log.js';
    configureSafeLogWriter(()=>{}); writeSafeLog({level:'warn',event:'model.http'});
    let blocked=false; try { configureSafeLogWriter(()=>{}); } catch { blocked=true; }
    setTimeout(()=>process.stdout.write(JSON.stringify({blocked,...getSafeLogSinkStatus()})),1100);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 2000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { blocked: true, dropped: 1, failures: 1, stalls: 1,
    stalled: true, queued: 0, inFlight: true });
});

/**
 * 模拟宿主协议使用 stdout，默认日志不得污染该协议。
 * 子进程只使用固定结构化日志，不访问外部模型。
 * 两个通道分别检查，不能假设共享写入者的行原子性。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('默认日志不污染宿主 stdout 协议', () => {
  const script = `import {writeSafeLog} from './dist/examples/agent-sandbox/src/safe-log.js';
    process.stdout.write('protocol-line\\n'); writeSafeLog({level:'warn',event:'model.http'});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, IAR_LOG_FORMAT: 'json' } });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, 'protocol-line\n');
  assert.deepEqual(JSON.parse(child.stderr), record);
});

/**
 * 实际启动脚本不得向协议标准输出写启动提示。
 * 超时只用于结束本地离线服务，不触发真实模型。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('离线启动脚本不写入 stdout', () => {
  const env = { ...process.env, IAR_SANDBOX_PORT: String(20000 + process.pid % 20000) };
  const child = spawnSync(process.execPath, ['scripts/run-agent-sandbox.mjs', '--brain', 'scripted'],
    { encoding: 'utf8', env, timeout: 1000 });
  assert.equal((child.error as NodeJS.ErrnoException | undefined)?.code, 'ETIMEDOUT', child.stderr);
  assert.equal(child.stdout, '');
});
