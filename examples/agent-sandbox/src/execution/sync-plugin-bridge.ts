/**
 * 提供主线程侧的同步插件执行桥。
 *
 * LocalWorkflow 的 ActionExecutor 要求同步返回 ActionResult，
 * 而插件 Handler 是异步协议；该桥把执行请求发给持久 worker 线程，
 * 主线程用 Atomics.wait 阻塞等待结果，从而在不修改 Workflow 的前提下
 * 让同步 executor 安全驱动任意异步插件。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { JsonValue } from '@iar/contracts';
import type { PluginHandlerContext, PluginHandlerResult } from '@iar/plugin-sdk';
import { Worker } from 'node:worker_threads';

/** worker 回传结果的联合类型。 */
type BridgeResponse =
  | { ok: true; result: PluginHandlerResult }
  | { ok: false; error: string };

/** 共享缓冲的头部字节数：Int32 flag + Uint32 长度。 */
const HEADER_BYTES = 8;

/** 共享缓冲的 payload 容量。 */
const PAYLOAD_BYTES = 1024 * 1024;

/**
 * 把异步插件 Handler 包装成同步调用的执行桥。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class SyncPluginBridge {
  private readonly worker: Worker;
  private readonly shared: SharedArrayBuffer;
  private readonly flag: Int32Array;
  private readonly lengthView: Uint32Array;
  private readonly payloadView: Uint8Array;
  private readonly decoder = new TextDecoder();
  private seq = 0;
  private disposed = false;

  /**
   * 创建并启动持久插件执行 worker。
   *
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor() {
    this.shared = new SharedArrayBuffer(HEADER_BYTES + PAYLOAD_BYTES);
    this.flag = new Int32Array(this.shared, 0, 1);
    this.lengthView = new Uint32Array(this.shared, 4, 1);
    this.payloadView = new Uint8Array(this.shared, HEADER_BYTES);
    this.worker = new Worker(new URL('./plugin-runner.worker.js', import.meta.url), {
      workerData: { shared: this.shared, payloadOffset: HEADER_BYTES }
    });
  }

  /**
   * 同步等待 worker 执行插件并返回结果。
   *
   * @param pluginId - 目标插件标识
   * @param input - 插件输入
   * @param context - 插件执行上下文
   * @param timeoutMs - 最长等待毫秒数
   * @returns 插件执行结果
   * @throws Error 当执行超时、worker 失败或桥已关闭
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public run(pluginId: string, input: JsonValue, context: PluginHandlerContext, timeoutMs = 10_000): PluginHandlerResult {
    if (this.disposed) throw new Error('插件执行桥已关闭');
    const requestSeq = this.seq + 1;
    this.worker.postMessage({ seq: requestSeq, pluginId, input, context });
    this.seq = requestSeq;
    // flag 当前必为 requestSeq-1（严格串行），等待 worker 改写成 requestSeq。
    const waitResult = Atomics.wait(this.flag, 0, requestSeq - 1, timeoutMs);
    if (waitResult === 'timed-out') throw new Error(`插件执行超时（${String(timeoutMs)}ms）`);
    const length = this.lengthView[0] ?? 0;
    const text = this.decoder.decode(this.payloadView.subarray(0, length));
    let response: BridgeResponse;
    try {
      response = JSON.parse(text) as BridgeResponse;
    } catch {
      throw new Error('插件执行结果解析失败');
    }
    if (!response.ok) throw new Error(response.error);
    return response.result;
  }

  /**
   * 终止底层 worker 并释放执行桥。
   *
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.worker.terminate();
  }
}
