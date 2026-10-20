/** 语义抽取、路由和动作执行。
 * 路由层复用核心状态和依赖，不承担会话资源生命周期。
 * 普通与流式入口调用同一组步骤以保持动作及事件顺序一致。
 * 未命中、缺参或策略拒绝都不会直接调用插件执行器。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import { randomUUID } from 'node:crypto';
import { SCHEMA_VERSIONS, type ActionDefinition, type ActionType, type BehaviorContext, type EventEnvelope, type JsonValue, type PendingReference, type PluginOperation, type PluginPolicyMetadata, type RuleExpression, type VerifiedFactRecord } from '@iar/contracts';
import { ModelGateway, SemanticExtractorAdapter, type HistoricalSemanticReference, type ModelGatewayResult, type ModelProfileRegistry, type SemanticFrame } from '@iar/decision';
import { PluginFirstRouter, resolveFactRelationCandidates, type AsyncDecisionAdapter, type FactRelationCandidateReference, type RouteResult } from '@iar/runtime';
import type { FunctionRule, PluginRule } from '@iar/rule-engine';
import type { PluginDescriptor, PluginHost } from '@iar/plugins';
import type { ActionExecutor, LocalWorkflow } from '@iar/workflow';
import { ScriptedModelProvider } from './models/scripted-provider.js';
import { SESSION_RUN_ID, SESSION_CORRELATION_ID, TURN_DEFINITION } from './session-core.js';
import type { CompactionContext } from './session-compaction.js';
import { buildActionInput, buildFacts, describeAction, sandboxOperationKind, toSlotMap } from './session-helpers.js';
import type { ExecuteTurnOutcome, ExtractFrameOutcome, ReferenceResolution, ResolvedFactReference, RouteEvidence, SandboxMode } from './session-types.js';

/** 路由读取和更新当前会话的状态，不拥有独立生命周期。 */
export type SessionRoutingContext = Pick<CompactionContext, 'eventStore' | 'projector' | 'gateway'> & {
  /** 模型模式决定语义抽取失败时是否允许离线降级。 */
  mode: SandboxMode;
  /** 注册表和插件宿主由会话持有，不随路由组件销毁。 */
  registry: ModelProfileRegistry;
  pluginHost: PluginHost;
  /** 从持久化恢复并持续维护的有界原文窗口。 */
  recentMessages: Array<{ role: string; text: string }>;
  /** 两阶段决策各自使用对应适配器。 */
  functionDecisionAdapter: AsyncDecisionAdapter;
  pluginDecisionAdapter: AsyncDecisionAdapter;
  /** 计数器影响动作标识和事件记录，必须反映宿主最新值。 */
  turnCount: number;
  decisionEventCount: number;
  /** 重置会替换工作流，因此读写均通过宿主访问器。 */
  workflow: LocalWorkflow;
  /** 确认与取消都操作宿主当前的待确认动作。 */
  pending: { action: ActionDefinition } | null;
  /** 工厂和排空回调保证事件仍进入同一个会话存储。 */
  createWorkflow: () => LocalWorkflow;
  createExecutor: () => ActionExecutor;
  drainWorkflowEvents: () => Promise<void>;
};

/** 语义抽取、路由和动作执行。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export class SandboxSessionRouting {
  /** 使用宿主提供的实时状态和执行能力。
   * @param context - 当前会话的路由依赖与状态
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  public constructor(private readonly context: SessionRoutingContext) {}
  /**
   * 执行语义抽取，brain 模式失败时用离线 ScriptedModelProvider 重试一次。
   * 降级仍使用相同结构化契约；失败结果只携带稳定原因码。
   * 返回的 semanticFallback 会进入路由证据，供调用方区分降级。
   *
   * @param traceId - 链路标识
   * @param runId - 运行标识
   * @param userText - 用户输入文本
   * @returns 语义帧（含是否走了离线兜底）或稳定失败摘要
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  public async extractFrame(traceId: string, runId: string, userText: string, behaviorContext: BehaviorContext, recentMessages = this.context.recentMessages, selectedDescriptor?: PluginDescriptor): Promise<ExtractFrameOutcome> {
    const descriptors = selectedDescriptor ? [selectedDescriptor] : this.context.pluginHost.descriptors();
    const extracted = await new SemanticExtractorAdapter(this.context.gateway).extract({ traceId, runId, input: { text: userText, behaviorContext, recentMessages, functionDescriptors: descriptors } });
    if (extracted.ok) return { ok: true, frame: selectedDescriptor ? constrainFrame(extracted.value, selectedDescriptor) : extracted.value, semanticFallback: false };
    if (this.context.mode === 'brain') {
      // 真实 LLM 抽取失败时降级到离线关键词抽取，保证链路可以继续。
      const retried = await this.retrySemanticWithScripted(traceId, runId, userText, behaviorContext, recentMessages, descriptors);
      if (retried.ok) return { ok: true, frame: selectedDescriptor ? constrainFrame(retried.value, selectedDescriptor) : retried.value, semanticFallback: true };
    }
    const route: RouteEvidence = { status: 'semantic_failed', reasonCode: extracted.error.code, semanticIntent: 'unknown', semanticConfidence: 0 };
    return { ok: false, route, reasonCode: extracted.error.code, reply: `语义抽取失败（${extracted.error.code}），请换个说法重试。` };
  }


  /**
   * 用离线 ScriptedModelProvider 作为 brain provider 重试语义抽取。
   *
   * 复用同一 profile registry 和 gateway 校验/超时/重试边界，
   * 只把 provider 换成离线实现，不放宽输出 Schema。
   *
   * @param traceId - 链路标识
   * @param runId - 运行标识
   * @param userText - 用户输入文本
   * @returns 离线抽取的结构化结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  protected async retrySemanticWithScripted(traceId: string, runId: string, userText: string, behaviorContext: BehaviorContext, recentMessages: Array<{ role: string; text: string }>, functionDescriptors: PluginDescriptor[]): Promise<ModelGatewayResult<SemanticFrame>> {
    const fallbackGateway = new ModelGateway({ registry: this.context.registry, providers: { brain: new ScriptedModelProvider() } });
    return new SemanticExtractorAdapter(fallbackGateway).extract({ traceId, runId, input: { text: userText, behaviorContext, recentMessages, functionDescriptors } });
  }


  /**
   * 用语义帧执行两阶段路由。
   *
   * @param traceId - 链路标识
   * @param runId - 运行标识
   * @param frame - 结构化语义帧
   * @returns 两阶段路由结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  public routeFrame(traceId: string, runId: string, frame: SemanticFrame, behaviorContext: BehaviorContext, currentMessage: string, recentMessages = this.context.recentMessages, selectedDescriptor?: PluginDescriptor): Promise<RouteResult> {
    const descriptors = selectedDescriptor ? [selectedDescriptor] : this.context.pluginHost.descriptors();
    const rules = createRoutingRules(descriptors);
    return new PluginFirstRouter().routeAsync({
      traceId,
      runId,
      facts: buildFacts(frame),
      behaviorContext,
      currentMessage,
      recentMessages,
      tenantId: 'tenant-sandbox',
      actorId: 'actor-sandbox',
      environment: 'sandbox',
      functionRules: rules.functionRules,
      pluginRules: rules.pluginRules,
      pluginHost: this.context.pluginHost,
      functionDecisionAdapter: this.context.functionDecisionAdapter,
      pluginDecisionAdapter: this.context.pluginDecisionAdapter,
      authorizePlugin: () => true
    });
  }

  /** 解析模型声明的历史关系，只返回事实链中已存在的记录。 */
  public resolveReferences(frame: SemanticFrame, behaviorContext: BehaviorContext): ReferenceResolution {
    const references = frame.references.filter(isHistoricalReference);
    if (references.length === 0) return { ok: true, references: [] };
    const history = behaviorContext.factHistory;
    if (!history) return { ok: false, reasonCode: 'reference_unresolved' };
    const resolved: ResolvedFactReference[] = [];
    for (const reference of references) {
      const scopedHistory = restrictToPendingCandidates(history, behaviorContext.pendingReference);
      const result = resolveFactRelationCandidates(scopedHistory, reference as FactRelationCandidateReference);
      if (result.status === 'resolved') {
        resolved.push({ text: reference.text, record: result.record });
        continue;
      }
      if (result.status === 'ambiguous') return ambiguousReference(reference, result.candidates);
      return { ok: false, reasonCode: 'reference_unresolved' };
    }
    return { ok: true, references: resolved };
  }


  /**
   * 把路由结果落成 Action 并交给 Workflow 执行。
   * 路由不完整、插件不可用及缺少必要槽位都不会执行动作。
   * 决策事件先于工作流执行追加，保持原来的事件顺序。
   *
   * @param context - 运行标识、用户输入、语义帧和路由结果
   * @returns 执行/待确认/澄清/失败的内部结果联合
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  public async prepareAndExecute(context: { runId: string; userText: string; frame: SemanticFrame; route: RouteResult; behaviorContext: BehaviorContext }): Promise<ExecuteTurnOutcome> {
    const { runId, userText, frame, route, behaviorContext } = context;
    if (!route.functionId || !route.pluginId) return { status: 'failed', reply: '路由结果缺少 Function 或 Plugin。', reasonCode: 'route_incomplete' };
    const resolved = this.context.pluginHost.resolveCandidate(route.functionId, route.pluginId);
    if (!resolved.ok) return { status: 'failed', reply: `路由选中的插件不可用（${resolved.error.code}）。`, reasonCode: resolved.error.code };
    if (resolved.value.manifest.pluginKind !== 'function') return { status: 'failed', reply: '路由选中的插件不是 Function 插件。', reasonCode: 'plugin_kind_invalid' };
    const manifest = resolved.value.manifest;
    const built = buildActionInput(route.functionId, frame.slots, userText, frame.action, behaviorContext, manifest.operations ?? []);
    if ('missing' in built) return { status: 'clarification', reply: `还缺少必要信息（${built.missing.join('、')}），请补充完整后再试。`, reasonCode: 'slots_missing' };
    const action = this.createAction({ runId, functionId: route.functionId, pluginId: route.pluginId, input: built.input, policy: manifest.policy, operations: manifest.operations ?? [] });
    await this.appendDecisionEvent({ runId, frame, route, input: built.input });
    return this.executePreparedAction(action, manifest.capabilities);
  }

  /** 按插件策略生成动作，读取操作保持低风险。
   * @param context - 路由标识、输入和插件策略
   * @returns 附带唯一标识和确认策略的动作
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  private createAction(context: { runId: string; functionId: string; pluginId: string; input: JsonValue; policy: PluginPolicyMetadata; operations: readonly PluginOperation[] }): ActionDefinition {
    const { runId, functionId, pluginId, input, policy, operations } = context;
    const operationKind = sandboxOperationKind(functionId, input, operations);
    return {
      schemaVersion: SCHEMA_VERSIONS.action,
      actionId: `action-sandbox-${randomUUID()}`,
      runId,
      functionId, pluginId,
      idempotencyKey: `${functionId}:${SESSION_RUN_ID}:${String(this.context.turnCount)}`,
      input,
      riskLevel: operationKind === 'action' ? policy.riskLevel : 'low',
      confirmationRequired: operationKind === 'action' ? policy.requiresConfirmation : false
    };
  }

  /** 启动动作工作流，记录事件后返回执行或待确认结果。
   * 执行前使用插件声明的能力集合，由工作流执行确认策略。
   * 只有实际完成执行才进入终态，待确认动作保留供后续操作。
   * @param action - 已准备的动作
   * @param capabilities - 插件声明的能力
   * @returns 动作的执行状态
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  private async executePreparedAction(action: ActionDefinition, capabilities: string[]): Promise<ExecuteTurnOutcome> {
    const runId = action.runId;
    // 每个回合使用独立 Workflow 实例，事件写入共享 EventLog 以保证全局唯一 ID。
    this.context.workflow = this.context.createWorkflow();
    this.context.workflow.start({ runId, definition: TURN_DEFINITION });
    if (action.confirmationRequired) this.context.workflow.transition({ runId, event: 'request_confirmation' });
    const executed = await this.context.workflow.execute({
      runId,
      action,
      requiredCapabilities: [...capabilities],
      grantedCapabilities: [...capabilities],
      authorized: true,
      executor: this.context.createExecutor()
    });
    await this.context.drainWorkflowEvents();
    if (!executed.ok) return this.failedPreparedAction(action, executed.reasonCode);
    this.context.workflow.transition({ runId, event: 'complete' });
    await this.context.drainWorkflowEvents();
    return { status: 'executed', action, actionResult: executed.value };
  }

  /** 将工作流拒绝映射为待确认或稳定失败结果。
   * confirmation_required 是暂停而非执行成功；其他拒绝不保存动作。
   * @param action - 被策略处理的动作
   * @param reasonCode - 工作流拒绝码
   * @returns 待确认或失败结果
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  private failedPreparedAction(action: ActionDefinition, reasonCode: string): ExecuteTurnOutcome {
    if (reasonCode === 'confirmation_required') {
      this.context.pending = { action };
      const resolved = this.context.pluginHost.resolveCandidate(action.functionId, action.pluginId);
      const descriptor = resolved.ok && resolved.value.manifest.pluginKind === 'function' ? resolved.value.manifest : undefined;
      return { status: 'awaiting_confirmation', action, reply: `即将执行高风险操作「${describeAction(action, descriptor)}」（插件 ${action.pluginId}），需要你的确认。` };
    }
    return { status: 'failed', reply: `动作被拒绝：${reasonCode}`, reasonCode };
  }


  /**
   * 追加记录路由证据的 decision.created 事件。
   * 事件先写入存储再应用于投影，保持 state 与事件序列一致。
   *
   * @param context - 会话运行标识、语义帧、路由及动作输入
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  protected async appendDecisionEvent(context: { runId: string; frame: SemanticFrame; route: RouteResult; input: JsonValue }): Promise<void> {
    const { runId, frame, route, input } = context;
    this.context.decisionEventCount += 1;
    const payload = this.buildDecisionPayload({ frame, route, input });
    const event: EventEnvelope = {
      schemaVersion: SCHEMA_VERSIONS.event,
      eventId: `sandbox-decision-${String(this.context.decisionEventCount)}`,
      eventName: 'decision.created',
      occurredAt: new Date().toISOString(),
      runId,
      correlationId: SESSION_CORRELATION_ID,
      payload
    };
    await this.context.eventStore.append(event);
    this.context.projector.apply(event);
  }

  /** 收集路由选择与语义槽位，供决策事件投影。
   * @param context - 语义帧、路由和动作输入
   * @returns 可序列化的事件载荷
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  private buildDecisionPayload(context: { frame: SemanticFrame; route: RouteResult; input: JsonValue }): Record<string, JsonValue> {
    const { frame, route, input } = context;
    const payload: Record<string, JsonValue> = {
      functionId: route.functionId ?? 'unknown',
      pluginId: route.pluginId ?? 'unknown',
      intent: frame.intent,
      actionName: route.functionId ?? 'unknown',
      semanticConfidence: frame.confidence,
      slots: toSlotMap(frame.slots),
      reasonCode: route.reasonCode,
      input
    };
    if (route.functionDecision?.score !== undefined) payload.functionScore = route.functionDecision.score;
    if (route.pluginDecision?.score !== undefined) payload.pluginScore = route.pluginDecision.score;
    if (route.routingScope !== undefined) payload.routingScope = route.routingScope as unknown as JsonValue;
    return payload;
  }

}

/** 判断引用是否为新版不透明历史关系。 */
function isHistoricalReference(reference: SemanticFrame['references'][number]): reference is HistoricalSemanticReference {
  return 'relation' in reference;
}

/** 将待解析引用限制在上一次运行时确认的候选集合内。 */
function restrictToPendingCandidates(history: NonNullable<BehaviorContext['factHistory']>, pendingReference: PendingReference | undefined): NonNullable<BehaviorContext['factHistory']> {
  if (pendingReference === undefined) return history;
  const candidateIds = new Set(pendingReference.candidateRecordIds);
  const records = history.records.filter((record) => candidateIds.has(record.recordId));
  const focusRecordId = pendingReference.anchorRecordId && candidateIds.has(pendingReference.anchorRecordId) ? pendingReference.anchorRecordId : undefined;
  return focusRecordId === undefined ? { records } : { records, focusRecordId };
}

/** 把有限候选转换为可持久化的通用待解析引用。 */
function ambiguousReference(reference: HistoricalSemanticReference, candidates: VerifiedFactRecord[]): ReferenceResolution {
  const pendingReference: PendingReference = {
    text: reference.text,
    relation: reference.relation,
    candidateRecordIds: candidates.map((candidate) => candidate.recordId),
    ...(reference.anchorRecordId === undefined ? {} : { anchorRecordId: reference.anchorRecordId }),
    ...(reference.offset === undefined ? {} : { offset: reference.offset })
  };
  return { ok: false, reasonCode: 'reference_ambiguous', pendingReference, candidates };
}

/** 根据当前启用 Plugin 描述构造无业务目录的 Function/Plugin 规则。 */
function createRoutingRules(descriptors: readonly PluginDescriptor[]): { functionRules: FunctionRule[]; pluginRules: PluginRule[] } {
  const functionRules = new Map<string, FunctionRule>();
  for (const descriptor of descriptors) {
    const current = functionRules.get(descriptor.functionId);
    if (current) {
      current.requiresConfirmation = current.requiresConfirmation || descriptor.operationMetadata.requiresConfirmation;
      current.riskLevel = higherRisk(current.riskLevel ?? descriptor.operationMetadata.riskLevel, descriptor.operationMetadata.riskLevel);
      continue;
    }
    functionRules.set(descriptor.functionId, {
      functionId: descriptor.functionId,
      riskLevel: descriptor.operationMetadata.riskLevel,
      requiresConfirmation: descriptor.operationMetadata.requiresConfirmation,
      evidenceCodes: [`runtime.function.${descriptor.candidateKey}`],
      rule: genericRule('function', `function-${descriptor.candidateKey}`, descriptor.functionId)
    });
  }
  const pluginRules = descriptors.map((descriptor) => ({
    pluginId: descriptor.pluginId,
    functionId: descriptor.functionId,
    requiredCapabilities: descriptor.capabilities,
    requiresConfirmation: descriptor.operationMetadata.requiresConfirmation,
    riskLevel: descriptor.operationMetadata.riskLevel,
    evidenceCodes: [`runtime.plugin.${descriptor.candidateKey}`],
    rule: genericRule('plugin', `plugin-${descriptor.candidateKey}`, descriptor.functionId)
  }));
  return { functionRules: [...functionRules.values()], pluginRules };
}

/** 构造只匹配结构化 semantic.intent 的通用规则，不解析业务关键词。 */
function genericRule(target: 'function', ruleId: string, functionId: string): FunctionRule['rule'];
function genericRule(target: 'plugin', ruleId: string, functionId: string): PluginRule['rule'];
function genericRule(target: 'function' | 'plugin', ruleId: string, functionId: string): FunctionRule['rule'] | PluginRule['rule'] {
  return { schemaVersion: SCHEMA_VERSIONS.rule, ruleId, version: '1.0.0', target, priority: 100, specificity: 1, unknownFieldPolicy: 'match_none', expression: intentEquals(functionId) } as FunctionRule['rule'] | PluginRule['rule'];
}

/** 生成稳定的意图匹配表达式。 */
function intentEquals(functionId: string): RuleExpression {
  return { condition: { field: 'semantic.intent', operator: 'equals', value: functionId } };
}

/** 合并同一 Function 下多个 Plugin 的最高风险策略。 */
function higherRisk(left: NonNullable<FunctionRule['riskLevel']>, right: PluginDescriptor['operationMetadata']['riskLevel']): NonNullable<FunctionRule['riskLevel']> {
  const rank = { low: 1, medium: 2, high: 3, critical: 4 } as const;
  return (left && rank[left] >= rank[right] ? left : right);
}

/** 将模型语义限制在用户已选择的当前候选范围内，不直接创建 Action。 */
function constrainFrame(frame: SemanticFrame, descriptor: PluginDescriptor): SemanticFrame {
  const action = frame.action !== undefined && descriptor.actionTypes.includes(frame.action as ActionType) ? frame.action : (descriptor.actionTypes[0] ?? 'unknown');
  return { ...frame, intent: descriptor.functionId, action };
}
