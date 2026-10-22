/**
 * 发送 OpenAI 兼容请求并记录受控的传输摘要。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import { ModelProviderError } from '@iar/runtime';
import type { JsonValue } from '@iar/contracts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { logModelHttpFailure, logModelInvalidResponse, logModelNetworkFailure, logModelSuccess } from '../safe-log.js';

/** 请求所需连接配置与提示词。 */
export type ModelTransportRequest = {
  connection: { apiKey: string | undefined; baseUrl: string | undefined; model: string };
  system: string;
  user: string;
  signal: AbortSignal;
  /** OpenAI-compatible Function tools，仅由 function.call 使用。 */
  tools?: readonly ModelTransportTool[];
  /** Function-call 工具选择策略。 */
  toolChoice?: JsonValue;
  /** 是否允许响应使用原生 tool_calls。 */
  allowToolCalls?: boolean;
  /** Nested tool route explicitly disables provider reasoning mode. */
  thinking?: { type: 'disabled' };
};
/** 响应内容的最小形状。 */
type CompletionResponse = { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }> };
/** OpenAI-compatible 工具请求的最小安全形状。 */
export type ModelTransportTool = { type: 'function'; function: { name: string; description: string; parameters: JsonValue } };
/** 温度与已有模型配置保持一致。 */
const TEMPERATURE = 0.2;
/** 模型 HTTP 响应的累计原始字节上限，包括 SSE 帧。 */
export const MAX_MODEL_RESPONSE_BYTES = 256 * 1024;
/** 用固定类型区分超限和网络异常，不保存上游内容。 */
export class ModelResponseLimitError extends ModelProviderError {
  /** 固定错误码兼容现有模型提供者错误。
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  public constructor() { super('provider_failed'); }
}
const limitContext = new AsyncLocalStorage<{ isExceeded: boolean }>();

/** 跟踪网关内部捕获的超限异常，避免回退误报成功。
 * @param action - 本次回复生成操作
 * @returns 完整回复，超限时抛出固定错误
 * @author lvdaxianer@yeah.net @date 2026-10-18
 */
export async function trackModelResponseLimit<T>(action: () => Promise<T>): Promise<T> {
  const state = { isExceeded: false };
  const result = await limitContext.run(state, action);
  if (state.isExceeded) throw new ModelResponseLimitError();
  return result;
}

/**
 * 限制累计读取的原始字节数。
 * @param current - 已读取字节数
 * @param chunk - 新读取数据
 * @returns 更新后的字节数
 * @throws ModelResponseLimitError 超出固定边界时拒绝
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function countModelBytes(current: number, chunk: Uint8Array): number {
  const total = current + chunk.byteLength;
  if (total > MAX_MODEL_RESPONSE_BYTES) {
    const state = limitContext.getStore();
    if (state) state.isExceeded = true;
    throw new ModelResponseLimitError();
  }
  return total;
}

/**
 * 发起请求并将网络和 HTTP 错误转换为稳定错误。
 *
 * @param request - 模型请求配置
 * @param isStream - 是否使用流式协议
 * @param startTime - 调用开始时间
 * @returns 成功的 HTTP 响应
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export async function fetchModelResponse(request: ModelTransportRequest, isStream: boolean, startTime: number): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${request.connection.baseUrl}/chat/completions`, createFetchOptions(request, isStream));
  } catch {
    // 网络或取消错误不输出异常原文。
    logModelNetworkFailure(startTime, request.signal);
    throw new ModelProviderError('provider_unavailable');
  }
  // 上游返回非成功状态时不读取或记录正文。
  if (!response.ok) {
    logModelHttpFailure(startTime, response.status);
    // 不读取错误正文，也不等待可能永不结束的底层取消。
    const body = response.body;
    // 无正文时没有需要取消的资源。
    if (body) cancelModelBody(() => body.cancel());
    throw new ModelProviderError('provider_failed');
  }
  return response;
}

/**
 * 发起尽力取消，不让清理失败或挂起覆盖业务错误。
 *
 * @param cancel - 流或 reader 的取消操作
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function cancelModelBody(cancel: () => Promise<void>): void {
  try {
    void cancel().catch(() => { /* 取消失败不改变原始结果。 */ });
  } catch {
    // 同步清理失败也不改变原始结果。
  }
}

/**
 * 构造与既有协议一致的 HTTP 请求。
 *
 * @param request - 模型请求配置
 * @param isStream - 是否使用流式协议
 * @returns fetch 选项
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function createFetchOptions(request: ModelTransportRequest, isStream: boolean): RequestInit {
  return { method: 'POST', signal: request.signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${request.connection.apiKey}` },
    body: JSON.stringify({ model: request.connection.model, temperature: TEMPERATURE,
      ...(isStream ? { stream: true } : request.allowToolCalls ? {} : { response_format: { type: 'json_object' } }),
      ...(request.thinking ? { thinking: request.thinking } : {}),
      ...(request.tools ? { tools: request.tools } : {}), ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
      messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }] }) };
}

/**
 * 执行普通模型请求并解析结构化输出。
 *
 * @param request - 模型请求配置
 * @returns 模型返回的 JSON 值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export async function callModel(request: ModelTransportRequest): Promise<unknown> {
  const startTime = Date.now();
  const response = await fetchModelResponse(request, false, startTime);
  const body = await readModelBody(response, { startTime, signal: request.signal });
  try {
    const payload = JSON.parse(body) as CompletionResponse;
    const toolCalls = payload.choices?.[0]?.message?.tool_calls;
    if (request.allowToolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
      logModelSuccess(startTime, response.status);
      return { toolCalls };
    }
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) throw new ModelProviderError('provider_failed');
    const result = JSON.parse(content) as unknown;
    logModelSuccess(startTime, response.status);
    return result;
  } catch {
    // 响应正文格式无效时不记录其内容。
    logModelInvalidResponse(startTime, response.status);
    throw new ModelProviderError('provider_failed');
  }
}

/**
 * 读取响应正文并独立分类传输错误。
 *
 * @param response - 模型 HTTP 响应
 * @param timing - 调用开始时间和取消信号
 * @returns 未解析的正文
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function readModelBody(response: Response, timing: { startTime: number; signal: AbortSignal }): Promise<string> {
  try {
    return await readBoundedBody(response);
  } catch (error) {
    // 超限视为无效响应，错误和日志均不包含原文。
    if (error instanceof ModelResponseLimitError) {
      logModelInvalidResponse(timing.startTime, response.status);
      throw error;
    }
    // 正文读取失败是网络或取消问题，不混同格式错误。
    logModelNetworkFailure(timing.startTime, timing.signal);
    throw new ModelProviderError('provider_failed');
  }
}

/**
 * 按块读取并在超限或读取故障时取消响应。
 * @param response - 上游响应
 * @returns 有界 UTF-8 正文
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size = countModelBytes(size, item.value);
      chunks.push(decoder.decode(item.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch (error) {
    cancelModelBody(() => reader.cancel());
    throw error;
  } finally { reader.releaseLock(); }
}
