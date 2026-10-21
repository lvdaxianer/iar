/**
 * 提供安全观测测试共用的隔离夹具。
 *
 * 夹具只替换进程内日志、fetch 与模型连接环境变量；测试结束后统一恢复。
 * 所有网络响应由测试注入，避免请求真实模型服务。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import { startSandboxServer, type SandboxServerHandle } from '../../../examples/agent-sandbox/src/server.js';
import { BrainModelProvider } from '../../../examples/agent-sandbox/src/models/llm-provider.js';
import type { PiAgentDelegate } from '../../../examples/agent-sandbox/src/models/pi-agent-delegate.js';
import type { ModelProviderRequest } from '@iar/decision';
import type { ModelGateway } from '@iar/decision';
import { safeLogIsIdleForTesting, setSafeLogWriterForTesting } from '../../../examples/agent-sandbox/src/safe-log.js';

/** 测试使用的固定本地连接，不包含真实凭据。 */
export const TEST_CONNECTION = { apiKey: 'key-private', baseUrl: 'http://127.0.0.1:1' };

/**
 * 保存并恢复测试改变的进程级状态。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export class ObservabilityFixture {
  /** 捕获的结构化安全日志。 */
  public readonly lines: string[] = [];
  /** 已启动的服务；未启动时没有需要关闭的监听器。 */
  public server: SandboxServerHandle | undefined;
  private readonly restoreWriter: () => void;
  private readonly originalFetch = globalThis.fetch;
  private readonly originalKey = process.env.IAR_LLM_API_KEY;
  private readonly originalUrl = process.env.IAR_LLM_BASE_URL;

  /**
   * 安装只保存在内存中的日志接收器。
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  public constructor() {
    this.restoreWriter = setSafeLogWriterForTesting((buffer, done) => {
      this.lines.push(buffer.toString().trimEnd());
      done(null, buffer.length);
    });
  }

  /**
   * 启动一个本地沙箱，并为 brain 模式指定测试连接。
   *
   * @param options - 沙箱模式和本地端口
   * @returns 已启动的服务句柄
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  public async start(options: { mode: 'brain' | 'scripted'; port: number; piAgentFactory?: (sessionId: string) => PiAgentDelegate }): Promise<SandboxServerHandle> {
    // 只有 brain 模式需要测试连接，scripted 保持原有环境。
    if (options.mode === 'brain') {
      process.env.IAR_LLM_API_KEY = TEST_CONNECTION.apiKey;
      process.env.IAR_LLM_BASE_URL = TEST_CONNECTION.baseUrl;
    }
    this.server = await startSandboxServer(options);
    return this.server;
  }

  /**
   * 读取捕获的结构化日志记录。
   *
   * @returns 已捕获的安全日志记录
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  public records(): Array<Record<string, unknown>> {
    return this.lines.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /**
   * 关闭服务并恢复所有被覆盖的进程状态。
   *
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  public async close(): Promise<void> {
    try {
      await this.server?.close();
    } finally {
      // 即使服务关闭失败也恢复全局状态，防止污染其他测试。
      globalThis.fetch = this.originalFetch;
      this.restoreWriter();
      restoreEnvironment('IAR_LLM_API_KEY', this.originalKey);
      restoreEnvironment('IAR_LLM_BASE_URL', this.originalUrl);
    }
  }
}

/**
 * 测试中以有界时间等待异步安全日志排空。
 * @returns 队列排空后完成
 * @throws Error 一秒内未排空时失败
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export async function flushObservabilityLogs(): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!safeLogIsIdleForTesting()) {
    // 日志卡住时必须失败，不能让整个测试套件无限等待。
    if (Date.now() >= deadline) throw new Error('安全日志未能排空');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * 恢复一个环境变量，包括原本不存在的情况。
 *
 * @param key - 环境变量名
 * @param value - 测试开始前的值
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function restoreEnvironment(key: string, value: string | undefined): void {
  // 未设置的变量必须删除，不能变成字符串 undefined。
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/**
 * 在独立夹具内执行测试，并始终恢复全局状态。
 *
 * @param run - 使用夹具执行断言的测试阶段
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export async function withObservabilityFixture(run: (fixture: ObservabilityFixture) => Promise<void>): Promise<void> {
  const fixture = new ObservabilityFixture();
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}

/**
 * 创建不访问真实服务的模型 provider。
 *
 * @returns 连接固定本地地址的 provider
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function createTestProvider(): BrainModelProvider {
  return new BrainModelProvider(TEST_CONNECTION);
}

/**
 * 创建普通语义模型测试使用的固定请求。
 *
 * @returns 包含敏感哨兵的测试请求
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function createSemanticRequest(): ModelProviderRequest {
  return { traceId: 'trace-test', runId: 'run-test', attempt: 1, input: { text: 'private-prompt' },
    signal: new AbortController().signal,
    profile: { schemaVersion: 'iar.model-profile/v1', profileId: 'test', profileVersion: '1',
      role: 'semantic.extract', provider: 'brain', modelId: 'test', modelVersion: '1', timeoutMs: 1000,
      retryPolicy: { maxAttempts: 1, backoffMs: 0, retryOn: [] },
      structuredOutput: { enabled: true, schemaId: 'iar.semantic-frame/v1' } } };
}

/**
 * 创建流式回复角色的固定请求，不包含真实凭据。
 * @returns 含敏感测试哨兵的模型请求
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function createStreamRequest(): ModelProviderRequest {
  return { ...createSemanticRequest(), input: { userMessage: 'prompt-private' },
    profile: { ...createSemanticRequest().profile, role: 'response.generate',
      structuredOutput: { enabled: true, schemaId: 'iar.response/v1' } } };
}

/**
 * 收集真实网关调用返回的业务审计链路，不修改调用结果。
 * @param server - 已启动的沙箱服务
 * @returns 随业务调用持续追加的审计标识
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function observeAuditTraces(server: SandboxServerHandle): string[] {
  const traces: string[] = [];
  const gateway = (server.session as unknown as { gateway: ModelGateway }).gateway;
  const originalInvoke = gateway.invoke.bind(gateway);
  gateway.invoke = (async (...args: Parameters<ModelGateway['invoke']>) => {
    const result = await originalInvoke(...args);
    traces.push(...result.audit.map((entry) => entry.traceId));
    return result;
  }) as ModelGateway['invoke'];
  return traces;
}
