/** 创建沙箱会话的插件、模型和决策依赖。 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_VERSIONS } from '@iar/contracts';
import { DecisionBackendResolver, FunctionCallAdapter, IntentModelDecisionAdapter, JevDecisionAdapter, ModelGateway, ModelProfileRegistry, NestedRouteAdapter, UnifiedDecisionAdapter, UnifiedFunctionCallAdapter, loadModelProfiles, type AsyncDecisionAdapter, type DecisionRequest, type ModelProvider } from '@iar/runtime';
import { createIarAgent, type IarRuntime, type SelfIntroductionOptions } from '@iar/runtime';
import { PluginHost } from '@iar/plugins';
import { allSandboxPlugins, sandboxFunctionIds } from './functions/index.js';
import { assertSandboxKnowledgeBases } from './knowledge/retrieval.js';
import { BrainModelProvider, IntentModelProvider, JevModelProvider } from './models/llm-provider.js';
import { ScriptedModelProvider } from './models/scripted-provider.js';
import { logModelAudit } from './safe-log.js';
import type { SandboxDecisionBackend, SandboxMode } from './session-types.js';

/** 安装沙箱的固定插件集合并预检知识库。
 * 只要一个依赖失败，调用方就不能继续提供部分初始化的会话。
 * 插件注册按既有集合顺序执行，保持候选集行为稳定。
 * @param decisionProvider - Function 路由决策适配器
 * @param options - Agent 级 Plugin 配置
 * @returns 已初始化的独立 Runtime
 * @throws Error 安装、启用或知识库校验失败
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
export function createSandboxRuntime(decisionProvider: AsyncDecisionAdapter, options: { disabledPluginIds?: readonly string[]; systemPrompt?: string; selfIntroduction?: SelfIntroductionOptions } = {}): IarRuntime {
  assertSandboxKnowledgeBases(sandboxFunctionIds);
  return createIarAgent({ plugins: allSandboxPlugins, decisionProvider, ...options });
}

/** 兼容旧调用方，仅返回沙箱 Runtime 的插件宿主。
 *
 * @param decisionProvider - Function 路由决策适配器
 * @param options - Agent 级 Plugin 配置
 * @returns 已启用的沙箱 PluginHost
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
export function createSandboxPluginHost(decisionProvider: AsyncDecisionAdapter, options: { disabledPluginIds?: readonly string[]; systemPrompt?: string; selfIntroduction?: SelfIntroductionOptions } = {}): PluginHost {
  return createSandboxRuntime(decisionProvider, options).pluginHost;
}

/** 从受控配置构建模型网关和两个决策适配器。
 * @param options - 模式与可选决策后端
 * @returns 相互绑定的模型依赖
 * @author lvdaxianer@yeah.net @date 2026-10-18
 */
export function createSandboxModels(options: { mode: SandboxMode; decisionBackend?: SandboxDecisionBackend }) {
  // 离线模式不访问远程模型，brain 模式保留真实 provider。
  const scripted = new ScriptedModelProvider();
  const brain = options.mode === 'brain' ? new BrainModelProvider() : scripted;
  const decision = createDecisionModelProvider();
  const intent = options.mode === 'brain' ? new IntentModelProvider() : decision;
  // brain 模式使用真实 JEV System One；scripted 模式才注入离线确定性 provider。
  const jev = options.mode === 'brain' ? new JevModelProvider() : decision;
  const registry = createSandboxRegistry(options.decisionBackend);
  const gateway = new ModelGateway({
    registry,
    providers: { brain, mock: decision, jev, 'intent-model': intent },
    onAudit: (audit, event) => logModelAudit(audit, event.errorCode)
  });
  const resolver = new DecisionBackendResolver(registry);
  return {
    brain,
    registry,
    gateway,
    functionAdapter: createAdapter(resolver, gateway, 'function.select'),
    pluginAdapter: createAdapter(resolver, gateway, 'plugin.select'),
    functionCallAdapter: new UnifiedFunctionCallAdapter(resolver, new FunctionCallAdapter(gateway, 'jev'), new FunctionCallAdapter(gateway, 'intent-model')),
    nestedRouteAdapter: new NestedRouteAdapter(gateway)
  };
}

/** 按配置选择决策后端，未指定时按 JEV 配置完整性自动选择。
 * @param backend - 显式指定的后端
 * @returns 经过过滤的模型注册表
 * @author lvdaxianer@yeah.net @date 2026-10-18
 */
function createSandboxRegistry(backend: SandboxDecisionBackend | undefined): ModelProfileRegistry {
  const text = readFileSync(join(process.cwd(), 'examples', 'agent-sandbox', 'config', 'models.brain.json'), 'utf8');
  // 显式参数优先于进程配置；未指定时仅在 JEV 三项完整时选择 JEV，否则使用 Intent Model。
  const selected = backend ?? readSandboxDecisionBackend() ?? (isJevConfigured() ? 'jev' : 'intent-model');
  if (selected === 'jev' && !isJevConfigured()) throw new Error('IAR_JEV_ENDPOINT、IAR_JEV_API_KEY 和 IAR_JEV_MODEL_ID 必须同时配置');
  const profiles = loadModelProfiles(text).filter((profile) => profile.role !== 'function.select' && profile.role !== 'plugin.select' || (profile.decisionBackend ?? 'jev') === selected);
  return new ModelProfileRegistry(profiles);
}

/** 创建指定角色的统一决策适配器。
 * @param resolver - 后端选择器
 * @param gateway - 模型网关
 * @param role - 决策角色
 * @returns 对应角色的适配器
 * @author lvdaxianer@yeah.net @date 2026-10-18
 */
function createAdapter(resolver: DecisionBackendResolver, gateway: ModelGateway, role: 'function.select' | 'plugin.select'): UnifiedDecisionAdapter {
  return new UnifiedDecisionAdapter(resolver, new JevDecisionAdapter(gateway, role), new IntentModelDecisionAdapter(gateway, role));
}

/** 读取可选的进程级决策后端。
 * @returns 已验证的后端或未配置
 * @throws Error 配置值不受支持
 * @author lvdaxianer@yeah.net @date 2026-10-18
 */
function readSandboxDecisionBackend(): SandboxDecisionBackend | undefined {
  const value = process.env.IAR_SANDBOX_DECISION_BACKEND;
  // 空值表示启用基于 JEV 配置完整性的自动选择，其他未支持值不可静默回退。
  if (value === undefined || value.length === 0) return undefined;
  if (value === 'jev' || value === 'intent-model') return value;
  throw new Error('IAR_SANDBOX_DECISION_BACKEND 必须是 jev 或 intent-model');
}

/**
 * 判断 JEV 是否具备完整的运行时配置。
 * @returns 三项 JEV 配置是否都存在且不是占位值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
function isJevConfigured(): boolean {
  return [process.env.IAR_JEV_ENDPOINT, process.env.IAR_JEV_API_KEY, process.env.IAR_JEV_MODEL_ID].every(isConfiguredValue);
}

function isConfiguredValue(value: string | undefined): boolean {
  const normalized = value?.trim();
  return normalized !== undefined && normalized.length > 0 && normalized !== 'CHANGE_ME';
}

/** 创建离线决策 provider，输出有限候选契约。
 * 该 provider 不生成新的候选标识，不能扩大调用方授权范围。
 * 决策版本和候选列表来自当前请求，供后续契约校验。
 * @returns 确定性本地 provider
 * @author lvdaxianer@yeah.net @date 2026-10-18
 */
function createDecisionModelProvider(): ModelProvider {
  // 本地 provider 仅从运行时提供的候选集中选取第一项。
  return { complete: async (request) => {
    if (request.profile.role === 'function.call') return createScriptedFunctionCall(request.input);
    const input = request.input as { request?: DecisionRequest } & Partial<DecisionRequest>;
    const decision = input.request ?? input as DecisionRequest;
    return { schemaVersion: SCHEMA_VERSIONS.decision, decisionType: decision.decisionType, decisionVersion: decision.decisionVersion,
      status: 'choice', choice: decision.candidates[0]?.candidateId, score: 0.99, reasonCode: 'sandbox.choice',
      candidateIds: decision.candidates.map((candidate) => candidate.candidateId) };
  } };
}

/** 离线模式模拟 Function Calling：只从 Runtime 提供的工具和 semantic slots 生成参数。 */
function createScriptedFunctionCall(rawInput: unknown): unknown {
  const input = asRecord(rawInput);
  const tools = Array.isArray(input.tools) ? input.tools.filter(isRecord) : [];
  const semantic = asRecord(input.semantic);
  const slots = asRecord(semantic.slots);
  const operation = typeof slots.operation === 'string' ? slots.operation : undefined;
  const tool = tools.find((item) => operation === undefined || item.operation === operation) ?? tools[0];
  if (!tool || typeof tool.pluginId !== 'string' || typeof tool.functionId !== 'string' || typeof tool.operation !== 'string') return { schemaVersion: 'iar.function-call/v1', pluginId: '', functionId: '', operation: '', arguments: {}, confidence: 0 };
  const args: Record<string, unknown> = { operation: tool.operation };
  const query = typeof slots.query === 'string' ? slots.query : typeof input.currentMessage === 'string' ? input.currentMessage : undefined;
  if (query) args.query = query;
  if (isRecord(slots.params)) args.params = slots.params;
  return { schemaVersion: 'iar.function-call/v1', pluginId: tool.pluginId, functionId: tool.functionId, operation: tool.operation, arguments: args, confidence: 0.99 };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
