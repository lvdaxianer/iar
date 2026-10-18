/**
 * 有界异步日志输出队列；任何故障都不会进入业务调用路径。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import { write } from 'node:fs';

/** 将一段 UTF-8 字节异步写入接收器。 */
export type SafeLogWriter = (buffer: Buffer, done: (error: Error | null, written: number) => void) => void;
/** 接收器依赖及有界配置。 */
export type SafeLogSinkOptions = { writer: SafeLogWriter; capacity: number; timeoutMs: number;
  serialize: (record: Record<string, unknown>) => string };
/** 异步写入回调的结果。 */
type WriteResult = { error: Error | null; written: number };
/** 不包含日志内容或异常的只读诊断快照。 */
export type SafeLogSinkStatus = { dropped: number; failures: number; stalls: number;
  stalled: boolean; queued: number; inFlight: boolean };
/** 输出适配器只使用异步文件描述符操作，不持有或关闭宿主输出。 */
export const defaultLogWriter: SafeLogWriter = (buffer, done) => {
  write(2, buffer, 0, buffer.length, null, (error, written) => done(error, written));
};

/**
 * 按 FIFO 排队，并在输出卡住时保持单个在途写入和固定内存上限。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export class SafeLogSink {
  private readonly queue: Buffer[] = [];
  private isScheduled = false;
  private isBusy = false;
  private needsSeparator = false;
  private isStalled = false;
  private timer: NodeJS.Timeout | undefined;
  private dropped = 0;
  private failures = 0;
  private stalls = 0;

  /**
   * 创建仅供当前进程使用的有界接收器。
   * @param options - 异步写入、白名单序列化及容量期限配置
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  public constructor(private readonly options: SafeLogSinkOptions) {}

  /**
   * 安全序列化并入队，满队列直接丢弃，不等待接收器。
   * @param record - 待筛选的结构化记录
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  public write(record: Record<string, unknown>): void {
    try {
      // 熔断或队列满时直接丢弃，不阻塞业务。
      if (this.isStalled || this.queue.length >= this.options.capacity) { this.addDropped(1); return; }
      this.queue.push(Buffer.from(`${this.options.serialize(record)}\n`));
      this.schedule();
    } catch { this.addDropped(1); this.failures = Math.min(Number.MAX_SAFE_INTEGER, this.failures + 1); }
  }

  /**
   * 输出不可变快照，计数不包含记录内容。
   * @returns 饱和计数及当前队列状态
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  public getStatus(): Readonly<SafeLogSinkStatus> {
    return Object.freeze({ dropped: this.dropped, failures: this.failures, stalls: this.stalls,
      stalled: this.isStalled, queued: this.queue.length, inFlight: this.isBusy });
  }

  /**
   * 对丢弃数做安全整数饱和累加。
   * @param count - 新增的丢弃数量
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private addDropped(count: number): void { this.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.dropped + count); }

  /**
   * 为测试查询队列状态，不等待不可恢复的输出。
   * @returns 是否没有待写入或在途记录
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  public isIdle(): boolean { return !this.isBusy && !this.isScheduled && this.queue.length === 0; }

  /**
   * 调度输出，确保调用者永不直接执行接收器。
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private schedule(): void {
    // 已有在途或调度任务时保持单一消费者。
    if (this.isBusy || this.isScheduled || this.queue.length === 0) return;
    this.isScheduled = true;
    setImmediate(() => { this.isScheduled = false; this.start(); });
  }

  /**
   * 只允许一条记录在途，防止慢接收器无限积压。
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private start(): void {
    const next = this.queue.shift();
    // 队列可能在调度和执行之间被清空。
    if (!next) return;
    this.isBusy = true;
    this.timer = setTimeout(() => this.expire(), this.options.timeoutMs);
    this.timer.unref();
    const buffer = this.needsSeparator ? Buffer.concat([Buffer.from('\n'), next]) : next;
    this.writePart(buffer, 0);
  }

  /**
   * 超时后丢弃等待记录，直到原有写入回调后才允许恢复。
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private expire(): void {
    // 超时记录交付结果未知，与排队记录共同计入放弃数量。
    this.addDropped(this.queue.length + 1);
    this.failures = Math.min(Number.MAX_SAFE_INTEGER, this.failures + 1);
    this.stalls = Math.min(Number.MAX_SAFE_INTEGER, this.stalls + 1);
    this.queue.length = 0;
    this.isStalled = true;
    this.needsSeparator = true;
  }

  /**
   * 完成当前记录，保留失败时的换行恢复标记。
   * @param isSuccess - 记录是否完整写入
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private finish(isSuccess: boolean): void {
    // 仍在运行的期限计时器必须在完成时释放。
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.needsSeparator = !isSuccess;
    this.isStalled = false;
    this.isBusy = false;
    this.schedule();
  }

  /**
   * 校验异步写入结果并推进或终止当前记录。
   * @param buffer - 当前完整日志记录
   * @param offset - 已确认写入的字节数
   * @param result - 写入错误和已确认的字节数
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private acceptWrite(buffer: Buffer, offset: number, result: WriteResult): void {
    const { error, written } = result;
    // 超时、写入失败或零进度都终止当前记录。
    if (this.isStalled || error || !Number.isInteger(written) || written <= 0 || written > buffer.length - offset) {
      // 迟到回调已在超时时计数，不得重复累计。
      if (!this.isStalled) { this.addDropped(1); this.failures = Math.min(Number.MAX_SAFE_INTEGER, this.failures + 1); }
      this.finish(false);
      return;
    }
    const next = offset + written;
    // 短写只续写剩余字节，并在调度时再次检查期限。
    if (next < buffer.length) {
      setImmediate(() => {
        // 调度期间超时则终止，否则继续写入剩余字节。
        if (this.isStalled) this.finish(false); else this.writePart(buffer, next);
      });
      return;
    }
    this.finish(true);
  }

  /**
   * 按字节续写；失败后为后续记录补充分隔符。
   * @param buffer - 当前完整日志记录
   * @param offset - 已写入的字节偏移
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private writePart(buffer: Buffer, offset: number): void {
    let isFinished = false;
    const done = (error: Error | null, written: number): void => {
      // 不可信适配器重复回调时只接受第一个结果。
      if (isFinished) return;
      isFinished = true;
      this.acceptWrite(buffer, offset, { error, written });
    };
    try { this.options.writer(buffer.subarray(offset), done); } catch { done(new Error('sink failure'), 0); }
  }
}
