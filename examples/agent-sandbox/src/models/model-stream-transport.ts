/**
 * 读取模型 SSE 流并在流终结时记录安全摘要。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import { ModelProviderError } from '@iar/decision';
import { logModelInvalidResponse, logModelNetworkFailure, logModelSuccess } from '../safe-log.js';
import { cancelModelBody, countModelBytes, fetchModelResponse, ModelResponseLimitError, type ModelTransportRequest } from './model-transport.js';

/** SSE 帧最小形状。 */
type StreamChunk = { choices?: Array<{ delta?: { content?: unknown } }> };
/** 流读取状态，仅用于本次调用。 */
type StreamState = { pending: string; chunks: string[]; onDelta: (delta: string) => void };

/**
 * 调用模型流式接口并返回完整正文。
 *
 * @param request - 模型请求配置
 * @param onDelta - 内容增量回调
 * @returns 模型响应正文
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export async function callModelStream(request: ModelTransportRequest, onDelta: (delta: string) => void): Promise<string> {
  const startTime = Date.now();
  const response = await fetchModelResponse(request, true, startTime);
  // 无响应流属于无效响应。
  if (response.body === null) {
    logModelInvalidResponse(startTime, response.status);
    throw new ModelProviderError('provider_failed');
  }
  const content = await readModelStream(response.body, onDelta, { startTime, signal: request.signal, status: response.status });
  // 空流无法生成回复。
  if (content.length === 0) {
    logModelInvalidResponse(startTime, response.status);
    throw new ModelProviderError('provider_failed');
  }
  logModelSuccess(startTime, response.status);
  return content;
}

/**
 * 持续读取流并将有效增量交给调用方。
 *
 * @param body - HTTP 响应流
 * @param onDelta - 内容增量回调
 * @param timing - 调用起始时间和取消信号
 * @returns 拼接后的模型正文
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function readModelStream(body: ReadableStream<Uint8Array>, onDelta: (delta: string) => void,
  timing: { startTime: number; signal: AbortSignal; status: number }): Promise<string> {
  const reader = body.getReader();
  const state: StreamState = { pending: '', chunks: [], onDelta };
  try {
    await consumeStream(reader, state);
  } catch (error) {
    // 中断时保持原有 provider 错误并只记录安全分类。
    cancelModelBody(() => reader.cancel());
    throw classifyStreamFailure(error, timing);
  } finally {
    // 无论读取结束或异常，释放持有的 reader 锁。
    reader.releaseLock();
  }
  return state.chunks.join('');
}

/** 将超限与连接故障分开记录，并保持对外稳定错误。
 * @param error - 流读取错误
 * @param timing - 状态码、计时及取消信号
 * @returns 应向上抛出的安全错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
function classifyStreamFailure(error: unknown, timing: { startTime: number; signal: AbortSignal; status: number }): Error {
  // 超限必须继续向上抛出，不能把已有增量当作完整答复。
  if (error instanceof ModelResponseLimitError) {
    logModelInvalidResponse(timing.startTime, timing.status);
    return error;
  }
  logModelNetworkFailure(timing.startTime, timing.signal);
  return new ModelProviderError('provider_unavailable');
}

/**
 * 逐块读取已取得锁的响应流。
 *
 * @param reader - 本次流读取器
 * @param state - 流解析状态
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function consumeStream(reader: ReadableStreamDefaultReader<Uint8Array>, state: StreamState): Promise<void> {
  const decoder = new TextDecoder();
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    // 流结束时保留既有的尾帧处理语义。
    if (done) return;
    size = countModelBytes(size, value);
    processStreamChunk(state, decoder.decode(value, { stream: true }));
  }
}

/**
 * 消费完整的 SSE 行并保留未完成的行。
 *
 * @param state - 当前流状态
 * @param text - 新解码内容
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function processStreamChunk(state: StreamState, text: string): void {
  const lines = [state.pending, text].join('').split(/\r?\n/);
  state.pending = lines.pop() ?? '';
  lines.forEach((line) => processStreamLine(state, line));
}

/**
 * 解析单个 SSE 数据行。
 *
 * @param state - 当前流状态
 * @param line - 完整数据行
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function processStreamLine(state: StreamState, line: string): void {
  const text = line.trim();
  // 非数据行和结束帧没有正文。
  if (!text.startsWith('data:')) return;
  const data = text.slice('data:'.length).trim(); // 结束标记不包含可交付正文。
  if (data === '[DONE]') return;
  let chunk: StreamChunk;
  try {
    chunk = JSON.parse(data) as StreamChunk;
  } catch {
    // 沿用原协议对异常帧的跳过策略。
    return;
  }
  const delta = chunk.choices?.[0]?.delta?.content;
  // 有效文本才交给界面并加入最终结果。
  if (typeof delta === 'string' && delta.length > 0) {
    state.chunks.push(delta);
    state.onDelta(delta);
  }
}
