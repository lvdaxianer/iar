/**
 * 记录单轮请求的阶段耗时和首 token 延迟。
 *
 * 只保存阶段名称、状态和数值，不保存用户输入、模型正文或 thinking 原文。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
import { performance } from 'node:perf_hooks';
import { safeModelTraceId, writeSafeLog } from './safe-log.js';

/**
 * 阶段最终状态。
 */
export type TimingStageStatus = 'completed' | 'failed' | 'skipped';

/**
 * 可观测阶段名称。
 */
export type TimingStage = 'semantic.extract' | 'route.propose' | 'route.select' | 'action.execute' | 'response.reasoning' | 'response.generate';

/**
 * 对外公开的阶段耗时摘要。
 */
export type TimingStageSummary = { stage: TimingStage; status: TimingStageStatus; durationMs: number; firstTokenMs?: number };

/**
 * 对外公开的单轮耗时摘要。
 */
export type TurnTimingSummary = { traceId: string; durationMs: number; stages: TimingStageSummary[] };

/**
 * 将阶段摘要写入安全结构化日志，不写入用户输入和模型原文。
 */
export function recordTurnTiming(summary: TurnTimingSummary): void {
  const traceId = safeModelTraceId(summary.traceId);
  summary.stages.forEach((stage) => writeSafeLog({ level: 'info', event: 'iar.turn.stage', traceId, stage: stage.stage, status: stage.status, durationMs: stage.durationMs, ...(stage.firstTokenMs === undefined ? {} : { firstTokenMs: stage.firstTokenMs }) }));
  writeSafeLog({ level: 'info', event: 'iar.turn.completed', traceId, durationMs: summary.durationMs });
}

type RunningStage = { stage: TimingStage; startedAt: number; firstTokenAt?: number };

/**
 * 单调记录阶段时间，允许同一阶段在一次请求中重复开始。
 * @param traceId - 当前请求的链路标识
 * @param now - 可注入时钟，测试时避免依赖真实等待
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
export class TurnTimingTracker {
  private readonly startedAt: number;
  private readonly running = new Map<TimingStage, RunningStage>();
  private readonly stages: TimingStageSummary[] = [];

  public constructor(public readonly traceId: string, private readonly now: () => number = () => performance.now()) {
    this.startedAt = this.now();
  }

  /**
   * 开始记录一个阶段；重复开始会结束上一段并保留最新段。
   */
  public start(stage: TimingStage): void {
    this.running.set(stage, { stage, startedAt: this.now() });
  }

  /**
   * 记录阶段完成、失败或跳过，并保存阶段耗时。
   */
  public end(stage: TimingStage, status: TimingStageStatus = 'completed'): void {
    const running = this.running.get(stage);
    if (!running) return;
    this.running.delete(stage);
    const durationMs = Math.max(0, Math.round(this.now() - running.startedAt));
    const firstTokenMs = running.firstTokenAt === undefined ? undefined : Math.max(0, Math.round(running.firstTokenAt - running.startedAt));
    this.stages.push({ stage, status, durationMs, ...(firstTokenMs === undefined ? {} : { firstTokenMs }) });
  }

  /**
   * 记录一个未进入执行的阶段，避免“没有日志”被误读成“阶段不存在”。
   *
   * @param stage - 被门禁跳过的阶段
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-23
   */
  public skip(stage: TimingStage): void {
    if (this.running.has(stage)) this.end(stage, 'failed');
    if (this.stages.some((item) => item.stage === stage)) return;
    this.stages.push({ stage, status: 'skipped', durationMs: 0 });
  }

  /**
   * 记录阶段首个可见 token 到达时间，只接受第一次。
   */
  public firstToken(stage: TimingStage): void {
    const running = this.running.get(stage);
    if (running && running.firstTokenAt === undefined) running.firstTokenAt = this.now();
  }

  /**
   * 结束所有未收尾阶段并返回不含原文的单轮摘要。
   */
  public finish(at = this.now()): TurnTimingSummary {
    for (const stage of [...this.running.keys()]) this.end(stage, 'failed');
    return { traceId: this.traceId, durationMs: Math.max(0, Math.round(at - this.startedAt)), stages: [...this.stages] };
  }
}
