/** 流式模型回复的超时、增量和回退边界。 */
import type { JsonValue } from '@iar/contracts';
import type { ClarificationMetadata, ModelProfileRegistry } from '@iar/decision';
import { OpenAICompatibleModelProvider } from './models/llm-provider.js';
import { ModelResponseLimitError } from './models/model-transport.js';
import { readResponseText } from './session-helpers.js';

/** 一次流式调用所需的数据及两类空回复回退。 */
export type StreamReplyRequest = {
  /** 提供流式响应的模型实现。 */
  provider: OpenAICompatibleModelProvider;
  /** 当前回复角色的超时和模型配置。 */
  profile: ReturnType<ModelProfileRegistry['forRole']>;
  /** 调用链和运行标识，用于沿用既有安全审计。 */
  traceId: string;
  runId: string;
  /** 已构建的模型输入，不作为日志内容。 */
  input: JsonValue;
  /** 增量直接透传到本次请求的流消费者。 */
  onDelta: (delta: string) => void;
  /** 结构化响应完成后更新 pending clarification。 */
  onClarification?: (clarification: ClarificationMetadata | undefined) => Promise<void>;
  /** 未获得有效结构化文本时的回退策略。 */
  onInvalid: () => Promise<string>;
  /** 普通连接失败且没有增量时的回退策略。 */
  onFailure: () => Promise<string>;
};

/** 调用流式模型，始终清理超时定时器。
 * 超限必须传播，避免将不完整增量当成正常回复。
 * 其他失败若已有增量，保留原有流式回退语义。
 * 有效结构化结果优先于透传的原始增量。
 * 定时器只限制模型调用，结束或异常时均必须清除。
 * 没有可用增量时由调用方选择对应回退，避免在此重执动作。
 * 增量上限由模型传输层按字节约束，而非依赖本字符串长度。
 * 调用方负责将超限错误转换为明确的不完整业务结果。
 * 增量回调的异常沿用既有失败边界，不记录内容本身。
 * @param request - 模型调用、增量接收和回退策略
 * @returns 完整回复或已有兼容回退文本
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export async function streamModelReply(request: StreamReplyRequest): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Model call timed out', 'TimeoutError')), request.profile.timeoutMs);
  let streamed = '';
  try {
    const parsed = await request.provider.completeStreamed({ traceId: request.traceId, runId: request.runId, profile: request.profile, input: request.input, attempt: 1, signal: controller.signal }, (delta) => {
      streamed += delta;
      request.onDelta(delta);
    });
    const text = readResponseText(parsed);
    if (text !== undefined) {
      if (request.onClarification) await request.onClarification(readClarification(parsed));
      return text;
    }
    if (streamed.trim().length > 0) return streamed;
    return request.onInvalid();
  } catch (error) {
    // 超限绝不使用部分输出作为完整回复。
    if (error instanceof ModelResponseLimitError) throw error;
    if (streamed.trim().length > 0) return streamed;
    return request.onFailure();
  } finally { clearTimeout(timer); }
}

function readClarification(raw: unknown): ClarificationMetadata | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const clarification = (raw as { clarification?: unknown }).clarification;
  return clarification as ClarificationMetadata | undefined;
}
