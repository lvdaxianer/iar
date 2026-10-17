/**
 * 提供 agent sandbox 的插件执行 worker 入口。
 *
 * worker 接收主线程经 postMessage 发送的执行请求，在独立事件循环中
 * 调用异步插件 Handler，再把结果写入 SharedArrayBuffer 并以 Atomics 唤醒主线程。
 * 这样 LocalWorkflow 的同步 ActionExecutor 可以安全地等待任意异步插件完成。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { JsonValue } from '@iar/contracts';
import type { PluginHandlerContext, PluginHandlerResult } from '@iar/plugin-sdk';
import { parentPort, workerData } from 'node:worker_threads';
import { sandboxPluginRegistry } from './plugin-registry.js';

/** 主线程发来的插件执行请求。 */
type RunnerRequest = {
  /** 单调递增的请求序号，回写为 SAB flag。 */
  seq: number;
  /** 目标插件标识。 */
  pluginId: string;
  /** 插件输入。 */
  input: JsonValue;
  /** 插件执行上下文。 */
  context: PluginHandlerContext;
};

/** worker 回写给主线程的结果联合。 */
type RunnerResponse =
  | { ok: true; result: PluginHandlerResult }
  | { ok: false; error: string };

/** 主线程与 worker 共享的 SAB 布局：Int32 flag + Uint32 长度 + payload。 */
type SharedLayout = {
  shared: SharedArrayBuffer;
  payloadOffset: number;
};

const layout = workerData as SharedLayout;
const flag = new Int32Array(layout.shared, 0, 1);
const lengthView = new Uint32Array(layout.shared, 4, 1);
const payloadView = new Uint8Array(layout.shared, layout.payloadOffset);
const encoder = new TextEncoder();

/**
 * 执行单个插件请求并把结果写入共享缓冲。
 *
 * @param request - 主线程发来的执行请求
 * @returns 无返回值，结果通过 SAB 回传
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
async function handle(request: RunnerRequest): Promise<void> {
  let response: RunnerResponse;
  try {
    const registration = sandboxPluginRegistry[request.pluginId];
    if (!registration || typeof registration.handler !== 'function') {
      response = { ok: false, error: `插件不可用: ${request.pluginId}` };
    } else {
      const result = await registration.handler(structuredClone(request.input), structuredClone(request.context));
      response = { ok: true, result };
    }
  } catch (error) {
    // worker 侧异常只回传稳定摘要，不带堆栈。
    response = { ok: false, error: error instanceof Error ? error.message : '插件执行异常' };
  }
  const bytes = encoder.encode(JSON.stringify(response));
  if (bytes.length > payloadView.length) {
    const fallback: RunnerResponse = { ok: false, error: '插件输出超出共享缓冲上限' };
    const fallbackBytes = encoder.encode(JSON.stringify(fallback));
    payloadView.set(fallbackBytes);
    lengthView[0] = fallbackBytes.length;
  } else {
    payloadView.set(bytes);
    lengthView[0] = bytes.length;
  }
  // 先写 payload 和长度，最后发布 flag，保证主线程读到完整结果。
  Atomics.store(flag, 0, request.seq);
  Atomics.notify(flag, 0);
}

if (parentPort === null) {
  throw new Error('plugin-runner.worker 只能以 worker 线程方式运行');
}

parentPort.on('message', (message: RunnerRequest) => {
  void handle(message);
});
