/** 语义抽取、路由和动作执行。
 * 路由层复用核心状态和依赖，不承担会话资源生命周期。
 * 普通与流式入口调用同一组步骤以保持动作及事件顺序一致。
 * 未命中、缺参或策略拒绝都不会直接调用插件执行器。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import { randomUUID } from 'node:crypto';
import { MAX_COLLECTION_ATTEMPTS, SCHEMA_VERSIONS, validateJsonSchemaValue, type ActionDefinition, type ActionType, type BehaviorContext, type CollectionState, type ConversationTurn, type EventEnvelope, type JsonSchema, type JsonValue, type PendingReference, type PluginOperation, type PluginPolicyMetadata, type RuleExpression, type VerifiedFactRecord } from '@iar/contracts';
import { SELF_INTRODUCTION_FUNCTION_ID, type PluginDescriptor, type PluginFunctionRecord, type PluginHost, type PluginRecord } from '@iar/plugins';
import { ModelGateway, SemanticExtractorAdapter, projectWorkflowContext, resolveOrderedReferenceCandidates, type HistoricalSemanticReference, type ModelGatewayResult, type ModelProfileRegistry, type OrderedReference, type SemanticFrame } from '@iar/runtime';
import { PluginFirstRouter, type AsyncDecisionAdapter, type AsyncFunctionCallAdapter, type AsyncNestedRouteAdapter, type RouteResult } from '@iar/runtime';
import type { FunctionRule, IarRuntimeConfiguration, PluginRule } from '@iar/runtime';
import type { ActionExecutor, LocalWorkflow } from '@iar/runtime';
import { ScriptedModelProvider } from './models/scripted-provider.js';
import { logModelAudit, logParameterBoundary, logSemanticFrame, type SemanticFrameDiagnostic } from './safe-log.js';
import { SESSION_RUN_ID, SESSION_CORRELATION_ID, TURN_DEFINITION } from './session-core.js';
import type { CompactionContext } from './session-compaction.js';
import { buildActionInput, buildFacts, buildFunctionCallInput, buildSelfIntroductionInput, describeAction, mergeResolvedReferenceParams, mergeVerifiedFunctionSlots, operationHasContradictoryPolicyText, operationHasTextEvidence, operationHasUnsupportedArgument, requiresGatewayRateClarification, sandboxOperationKind, toSlotMap } from './session-helpers.js';
import { isExplicitSideEffectRequest } from './session-clarification.js';
import { collectParameters, parameterCollectionReply } from './parameter-collector.js';
import type { ExecuteTurnOutcome, ExtractFrameOutcome, PendingActionContext, ReferenceResolution, ResolvedContextReference, RouteEvidence, SandboxMode, StructuredInput } from './session-types.js';

/** 路由读取和更新当前会话的状态，不拥有独立生命周期。 */
export type SessionRoutingContext = Pick<CompactionContext, 'eventStore' | 'projector' | 'gateway'> & {
  /** 模型模式决定语义抽取失败时是否允许离线降级。 */
  mode: SandboxMode;
  /** 注册表和插件宿主由会话持有，不随路由组件销毁。 */
  registry: ModelProfileRegistry;
  pluginHost: PluginHost;
  /** Agent 创建时保存的自我介绍配置。 */
  configuration: IarRuntimeConfiguration;
  /** 从持久化恢复并持续维护的有界原文窗口。 */
  recentMessages: Array<{ role: string; text: string }>;
  /** 两阶段决策各自使用对应适配器。 */
  functionDecisionAdapter: AsyncDecisionAdapter;
  pluginDecisionAdapter: AsyncDecisionAdapter;
  functionCallAdapter: AsyncFunctionCallAdapter;
  /** 普通交互模型的一次性 nested route proposal。 */
  nestedRouteAdapter: AsyncNestedRouteAdapter;
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
  public async extractFrame(traceId: string, runId: string, userText: string, behaviorContext: BehaviorContext, recentMessages = this.context.recentMessages, selectedDescriptor?: PluginDescriptor, pendingAction?: PendingActionContext, structuredInput?: StructuredInput): Promise<ExtractFrameOutcome> {
    // Semantic Extractor 必须看到 FunctionId 与 PluginId 的同一授权快照；Plugin 级描述无法满足闭集 intent 契约。
    const descriptors = selectedDescriptor ? this.context.pluginHost.descriptors().filter((descriptor) => descriptor.pluginId === selectedDescriptor.pluginId) : this.context.pluginHost.descriptors();
    const input = { text: userText, behaviorContext, workflowContext: projectWorkflowContext(behaviorContext), recentMessages, pluginDescriptors: descriptors, ...(pendingAction === undefined ? {} : { pendingAction }), ...(structuredInput === undefined ? {} : { structuredInput }) };
    const extracted = await new SemanticExtractorAdapter(this.context.gateway).extract({ traceId, runId, input });
    if (extracted.ok) {
      const frame = selectedDescriptor ? constrainFrame(extracted.value, selectedDescriptor) : extracted.value;
      logSemanticFrame(traceId, semanticFrameDiagnostic(frame));
      return { ok: true, frame, semanticFallback: false };
    }
    if (this.context.mode === 'brain') {
      // 真实 LLM 抽取失败时降级到离线关键词抽取，保证链路可以继续。
      const retried = await this.retrySemanticWithScripted(traceId, runId, userText, behaviorContext, recentMessages, descriptors, structuredInput);
      if (retried.ok) {
        const frame = selectedDescriptor ? constrainFrame(retried.value, selectedDescriptor) : retried.value;
        logSemanticFrame(traceId, semanticFrameDiagnostic(frame));
        return { ok: true, frame, semanticFallback: true };
      }
    }
    logSemanticFrame(traceId, { status: 'failed', hasIntent: false, hasAction: false, nextStage: 'response.generate' });
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
  protected async retrySemanticWithScripted(traceId: string, runId: string, userText: string, behaviorContext: BehaviorContext, recentMessages: Array<{ role: string; text: string }>, pluginDescriptors: PluginDescriptor[], structuredInput?: StructuredInput): Promise<ModelGatewayResult<SemanticFrame>> {
    const fallbackGateway = new ModelGateway({
      registry: this.context.registry,
      providers: { brain: new ScriptedModelProvider() },
      onAudit: (audit, event) => logModelAudit(audit, event.errorCode)
    });
    return new SemanticExtractorAdapter(fallbackGateway).extract({ traceId, runId, input: { text: userText, behaviorContext, workflowContext: projectWorkflowContext(behaviorContext), recentMessages, pluginDescriptors, ...(structuredInput === undefined ? {} : { structuredInput }) } });
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
      functionCallAdapter: this.context.functionCallAdapter,
      nestedRouteAdapter: this.context.nestedRouteAdapter,
      authorizePlugin: () => true
    });
  }

  /** 解析模型声明的历史关系，只返回事实链中已存在的记录。 */
  public resolveReferences(frame: SemanticFrame, behaviorContext: BehaviorContext): ReferenceResolution {
    const references = frame.references.filter(isHistoricalReference);
    if (references.length === 0) return { ok: true, references: [] };
    const resolved: ResolvedContextReference[] = [];
    for (const reference of references) {
      const scope = reference.scope === 'conversation_turn' ? 'conversation_turn' : 'fact_history';
      if (scope === 'conversation_turn') {
        const turns = behaviorContext.conversationTurns;
        if (!turns || turns.turns.length === 0) return { ok: false, reasonCode: 'reference_unresolved' };
        const result = resolveOrderedReferenceCandidates({
          items: turns.turns.map((turn) => ({ id: turn.turnId, sequence: turn.sequence, turn })),
          ...(turns.focusTurnId === undefined ? {} : { focusId: turns.focusTurnId })
        }, orderedReference(reference, scope));
        if (result.status === 'resolved') {
          resolved.push({ text: reference.text, turn: result.item.turn });
          continue;
        }
        return { ok: false, reasonCode: 'reference_unresolved' };
      }
      const history = restrictToPendingCandidates(behaviorContext.factHistory, behaviorContext.pendingReference);
      if (!history || history.records.length === 0) {
        const cancelledTurn = resolveCancelledConversationTurn(reference, behaviorContext.conversationTurns);
        if (cancelledTurn !== undefined) {
          resolved.push({ text: reference.text, turn: cancelledTurn });
          continue;
        }
        return { ok: false, reasonCode: 'reference_unresolved' };
      }
      const scopedHistory = restrictToCurrentFactBatch(history, reference.relation);
      const result = resolveOrderedReferenceCandidates({
        items: scopedHistory.records.map((record) => ({ id: record.recordId, sequence: record.sequence, record })),
        ...(scopedHistory.focusRecordId === undefined ? {} : { focusId: scopedHistory.focusRecordId })
      }, orderedReference(reference, scope));
      if (result.status === 'resolved') {
        resolved.push({ text: reference.text, record: result.item.record });
        continue;
      }
      if (result.status === 'ambiguous') return ambiguousReference(reference, result.candidates.map((candidate) => candidate.record));
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
  public async prepareAndExecute(context: { runId: string; traceId?: string; userText: string; frame: SemanticFrame; route: RouteResult; behaviorContext: BehaviorContext; resolvedReferences?: readonly ResolvedContextReference[] }): Promise<ExecuteTurnOutcome> {
    const { route, frame, behaviorContext, userText, runId, traceId = runId, resolvedReferences = [] } = context;
    const resolved = this.resolveFunctionContext(route);
    if (!resolved.ok) return resolved.result;
    // 这是动作执行前的最后一道统一安全边界，覆盖 semantic action 漏标、
    // Function Calling proposal 以及上下文继承等所有输入构造路径。
    if (route.functionId === 'api.gateway' && requiresGatewayRateClarification(userText)) {
      return gatewayRateClarificationResult();
    }
    const prepared = this.prepareFunctionInput({ traceId, route, frame, behaviorContext, userText, functionRecord: resolved.functionRecord, resolvedReferences });
    if (!prepared.ok) return prepared.result;
    const operationKind = sandboxOperationKind(route.functionId!, prepared.input, resolved.functionRecord.operations);
    const action = this.createAction({ runId, functionId: route.functionId!, pluginId: route.pluginId!, input: prepared.input, policy: resolved.manifest.policy, operations: resolved.functionRecord.operations });
    await this.appendDecisionEvent({ runId, frame, route, input: prepared.input });
    return this.executePreparedAction(action, resolved.manifest.capabilities, operationKind);
  }

  /**
   * 解析已由路由层选中的 Function，并把实现归属固定在注册表记录上。
   *
   * @param route - 已完成候选选择的路由结果
   * @returns 注册表中的插件和 Function，或稳定失败结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-23
   */
  private resolveFunctionContext(route: RouteResult): { ok: true; manifest: PluginRecord['manifest']; functionRecord: PluginFunctionRecord } | { ok: false; result: ExecuteTurnOutcome } {
    if (!route.functionId || !route.pluginId) return { ok: false, result: { status: 'failed', reply: '路由结果缺少 Function 或 Plugin。', reasonCode: 'route_incomplete' } };
    const resolved = this.context.pluginHost.resolveCandidate(route.functionId, route.pluginId);
    if (!resolved.ok) return { ok: false, result: { status: 'failed', reply: `路由选中的插件不可用（${resolved.error.code}）。`, reasonCode: resolved.error.code } };
    const functionRecord = resolved.value.functions.get(route.functionId);
    if (!functionRecord) return { ok: false, result: { status: 'failed', reply: '路由选中的 Plugin 不包含目标 Function。', reasonCode: 'function_unavailable' } };
    return { ok: true, manifest: resolved.value.manifest, functionRecord };
  }

  /**
   * 在固定 Function Schema 内合并、校验并生成动作输入，失败时只返回收集结果。
   *
   * @param context - 当前 Function、语义帧与用户补充信息
   * @returns 可执行输入或参数收集结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-23
   */
  private prepareFunctionInput(context: { traceId: string; route: RouteResult; frame: SemanticFrame; behaviorContext: BehaviorContext; userText: string; functionRecord: PluginFunctionRecord; resolvedReferences: readonly ResolvedContextReference[] }): { ok: true; input: JsonValue } | { ok: false; result: ExecuteTurnOutcome } {
    const { traceId, route, frame, behaviorContext, userText, functionRecord, resolvedReferences } = context;
    const slots = mergeResolvedReferenceParams(mergeVerifiedFunctionSlots(frame.slots, behaviorContext, functionRecord.definition.inputSchema), resolvedReferences, route.functionId ?? frame.intent);
    if (frame.action !== 'query' && frame.action !== 'unknown' && isExplicitSideEffectRequest(userText) && !functionRecord.operations.some((operation) => operation.kind === 'action')) {
      return { ok: false, result: unsupportedOperationResult() };
    }
    const proposal = route.functionCallProposal;
    const proposalCompatible = proposal !== undefined && (isFunctionCallProposalCompatible(proposal.operation, frame.action, functionRecord.operations)
      || (frame.action === 'query' && userText.trim().startsWith('candidate-') && functionRecord.operations.every((operation) => operation.kind === 'read')));
    // 当前语义帧和用户文本是本轮的最高优先级。route.propose 可能带有旧的或默认的
    // arguments（例如把上一轮 50/s 继续带成 300/s），不能让它覆盖当前补充值；
    // proposal 只在当前动作仍未知时作为完整 Function Call 兜底。
    const hasCurrentOperation = typeof slots.operation === 'string' && slots.operation.trim().length > 0;
    const proposalCanFillMissingOperation = proposalCompatible && proposal !== undefined && (hasCurrentOperation || hasGroundedProposalOperation(frame.action, proposal.operation, functionRecord.operations, userText));
    const proposalOperationSlots = proposalCanFillMissingOperation && proposal !== undefined && !hasCurrentOperation
        ? { ...slots, operation: proposal.operation }
        : slots;
    const corroboratedOperation = proposalCompatible && proposal !== undefined && behaviorContext.route.functionId !== route.functionId && typeof slots.operation === 'string' && slots.operation === proposal.operation
      ? proposal.operation
      : undefined;
    // Function Calling proposal 在 action=unknown 时会绕过 buildActionInput；高风险
    // 网关限流仍必须经过同一条明确目标值门禁，不能因模型把动作类型漏标而确认猜测值。
    if (route.functionId === 'api.gateway' && requiresGatewayRateClarification(userText)) {
      return { ok: false, result: gatewayRateClarificationResult() };
    }
    const usesFunctionCallProposal = route.functionId !== SELF_INTRODUCTION_FUNCTION_ID
      && proposalCanFillMissingOperation
      && frame.action === 'unknown'
      && proposal !== undefined;
    let built = route.functionId === SELF_INTRODUCTION_FUNCTION_ID
      ? { input: buildSelfIntroductionInput(this.context.pluginHost.allDescriptors(), this.context.configuration.selfIntroduction.extraPrompt) }
      : usesFunctionCallProposal
        ? buildFunctionCallInput(proposal)
        : buildActionInput(route.functionId!, proposalOperationSlots, userText, frame.action, behaviorContext, functionRecord.operations, corroboratedOperation);
    if ('reasonCode' in built && built.reasonCode === 'operation_conflict') return this.parameterCollectionResult({ traceId, route, frame, functionRecord, behaviorContext, value: slots, requiredFields: ['operation'], conflictFields: ['operation'], fallback: { reasonCode: 'parameters_required', reply: '操作信息不一致，请确认后再试。' } });
    if ('missing' in built) {
      if (built.reasonCode === 'operation_missing') {
        if ((frame.action !== 'query' && frame.action !== 'unknown' && hasSpecificUnmatchedActionRequest(functionRecord.operations, userText, frame.action, behaviorContext))
          || (frame.action === 'unknown' && isExplicitSideEffectRequest(userText))) {
          return { ok: false, result: unsupportedOperationResult() };
        }
        const collected = this.parameterCollectionResult({ traceId, route, frame, functionRecord, behaviorContext, value: slots, requiredFields: ['operation'] });
        if (!collected.ok && collected.result.status === 'clarification') return { ok: false, result: { ...collected.result, reply: operationCatalogReply(functionRecord.operations, frame.action) } };
        return { ok: false, result: { status: 'clarification', reply: operationCatalogReply(functionRecord.operations, frame.action), reasonCode: built.reasonCode, diagnostic: { reasonCode: built.reasonCode, expectedOperation: functionRecord.operations.filter((operation) => frame.action === 'query' ? operation.kind === 'read' : frame.action === 'unknown' || operation.kind === 'action').map((operation) => operation.name).join('|').slice(0, 256) } } };
      }
      const requiredFields = schemaFields(functionRecord.definition.inputSchema, built.missing);
      if (requiredFields.length === 0) return { ok: false, result: { status: 'clarification', reply: `还缺少必要信息（${built.missing.join('、')}），请补充完整后再试。`, reasonCode: built.reasonCode } };
      return this.parameterCollectionResult({ traceId, route, frame, functionRecord, behaviorContext, value: slots, requiredFields });
    }
    const builtOperation = readOperationName(built.input);
    const builtOperationIsAction = builtOperation !== undefined && functionRecord.operations.some((operation) => operation.name === builtOperation && operation.kind === 'action');
    const selectedOperation = functionRecord.operations.find((operation) => operation.name === builtOperation);
    if (selectedOperation !== undefined && requiresReadOperationClarification({ selectedOperation, operations: functionRecord.operations, behaviorContext, route, userText, frame, corroboratedOperation })) {
      return { ok: false, result: operationMissingClarification(functionRecord.operations, frame.action) };
    }
    if (selectedOperation !== undefined && operationHasContradictoryPolicyText(selectedOperation, userText)) {
      return { ok: false, result: unsupportedOperationResult() };
    }
    if (selectedOperation !== undefined && operationHasUnsupportedArgument(selectedOperation, userText)) {
      return this.parameterCollectionResult({ traceId, route, frame, functionRecord, behaviorContext, value: omitParams(slots), requiredFields: ['params'] });
    }
    if (selectedOperation !== undefined && builtOperationIsAction && operationNeedsDescribedTarget(selectedOperation, userText, frame.action) && !hasVerifiedOperationParams(behaviorContext, route.functionId, builtOperation)) {
      return this.parameterCollectionResult({ traceId, route, frame, functionRecord, behaviorContext, value: omitParams(slots), requiredFields: ['params'] });
    }
    if (builtOperationIsAction && frame.workflowDecision?.event === 'parameter_invalid' && !hasStructuredParams(built.input)) {
      if (selectedOperation !== undefined && operationNeedsDescribedTarget(selectedOperation, userText, frame.action) && !hasVerifiedOperationParams(behaviorContext, route.functionId, builtOperation)) {
        return this.parameterCollectionResult({ traceId, route, frame, functionRecord, behaviorContext, value: omitParams(slots), requiredFields: ['params'] });
      }
      if (selectedOperation !== undefined && !operationHasTextEvidence(selectedOperation, userText, frame.action)) {
        return { ok: false, result: { status: 'clarification', reply: operationCatalogReply(functionRecord.operations, frame.action), reasonCode: 'operation_missing', diagnostic: { reasonCode: 'operation_missing', expectedOperation: functionRecord.operations.filter((operation) => frame.action === 'query' ? operation.kind === 'read' : frame.action === 'unknown' || operation.kind === 'action').map((operation) => operation.name).join('|').slice(0, 256) } } };
      }
      return this.parameterCollectionResult({ traceId, route, frame, functionRecord, behaviorContext, value: omitParams(slots), requiredFields: ['params'] });
    }
    if (!validateJsonSchemaValue(functionRecord.definition.inputSchema, built.input).ok) {
      // 模型产生的所有动作参数都只是不可信候选；若合并后的输入与固定
      // Function Schema 不符，丢弃整组非法字段，并基于本轮用户文本重建。
      // 这样不会把 description 等旧/幻觉字段直接带进参数收集，同时仍保持
      // 同一个已验证 Function 和已校验的 operation 边界。
      if (route.functionId !== SELF_INTRODUCTION_FUNCTION_ID) {
        const repairedSlots = proposal !== undefined && proposalCanFillMissingOperation
          ? { ...slots, operation: proposal.operation }
          : proposalOperationSlots;
        const builtOperation = 'input' in built && typeof built.input === 'object' && built.input !== null && !Array.isArray(built.input) && typeof (built.input as Record<string, unknown>).operation === 'string'
          ? (built.input as Record<string, unknown>).operation
          : undefined;
        const proposalIsAction = proposal !== undefined && proposalCompatible;
        const builtOperationIsAction = typeof builtOperation === 'string' && functionRecord.operations.some((operation) => operation.name === builtOperation && operation.kind === 'action');
        const repairedAction = frame.action === 'unknown' && (proposalIsAction || builtOperationIsAction) ? 'execute' : frame.action;
        const repaired = buildActionInput(route.functionId!, repairedSlots, userText, repairedAction, behaviorContext, functionRecord.operations, corroboratedOperation);
        if ('input' in repaired && validateJsonSchemaValue(functionRecord.definition.inputSchema, repaired.input).ok) return { ok: true, input: repaired.input };
        if ('reasonCode' in repaired && repaired.reasonCode === 'operation_conflict') return this.parameterCollectionResult({ traceId, route, frame, functionRecord, behaviorContext, value: slots, requiredFields: ['operation'], conflictFields: ['operation'], fallback: { reasonCode: 'parameters_required', reply: '操作信息不一致，请确认后再试。' } });
        if ('missing' in repaired) {
          const requiredFields = schemaFields(functionRecord.definition.inputSchema, repaired.missing);
          if (requiredFields.length > 0) return this.parameterCollectionResult({ traceId, route, frame, functionRecord, behaviorContext, value: slots, requiredFields });
        }
      }
      return this.parameterCollectionResult({ traceId, route, frame, functionRecord, behaviorContext, value: built.input });
    }
    return { ok: true, input: built.input };
  }

  /**
   * 把 Schema 校验失败转换为参数收集或稳定澄清结果。
   *
   * @param context - 固定 Function 的 Schema 校验上下文
   * @returns 可执行输入或不执行的澄清结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-23
   */
  private parameterCollectionResult(context: { traceId: string; route: RouteResult; frame: SemanticFrame; functionRecord: PluginFunctionRecord; behaviorContext: BehaviorContext; value: unknown; requiredFields?: readonly string[]; conflictFields?: readonly string[]; fallback?: { reasonCode: string; reply: string } }): { ok: true; input: JsonValue } | { ok: false; result: ExecuteTurnOutcome } {
    const collected = this.collectParameterState(context);
    if (collected.status === 'collecting') return { ok: false, result: this.parameterClarification(context.traceId, collected.state, context.functionRecord.operations, context.frame.action) };
    if (context.fallback) return { ok: false, result: { status: 'clarification', reply: context.fallback.reply, reasonCode: context.fallback.reasonCode } };
    return { ok: true, input: collected.input };
  }

  /** 按已固定 Function 的 Schema 生成一次参数收集结果，不触发执行器。 */
  private collectParameterState(context: { traceId: string; route: RouteResult; frame: SemanticFrame; functionRecord: { definition: { inputSchema: JsonSchema; schemaVersion: string; version: string } }; behaviorContext: BehaviorContext; value: unknown; requiredFields?: readonly string[]; conflictFields?: readonly string[] }): ReturnType<typeof collectParameters> {
    const { route, frame, functionRecord, behaviorContext, value, requiredFields, conflictFields } = context;
    const previous = behaviorContext.collection?.kind === 'parameters' ? behaviorContext.collection : undefined;
    return collectParameters({
      functionId: route.functionId ?? frame.intent,
      ...(route.pluginId === undefined ? {} : { pluginId: route.pluginId }),
      schemaVersion: `${functionRecord.definition.schemaVersion}:${functionRecord.definition.version}`.slice(0, 256),
      schema: functionRecord.definition.inputSchema,
      value,
      ...(requiredFields === undefined ? {} : { requiredFields }),
      ...(conflictFields === undefined ? {} : { conflictFields }),
      ...(previous === undefined ? {} : { previous }),
      attempt: Math.min(MAX_COLLECTION_ATTEMPTS, (previous?.attempt ?? 0) + 1)
    });
  }

  /** 把收集状态转换成不带业务词汇的内部澄清结果。 */
  private parameterClarification(traceId: string, state: Extract<CollectionState, { kind: 'parameters' }>, operations: readonly PluginOperation[], action: SemanticFrame['action']): ExecuteTurnOutcome {
    const fieldName = state.missingFields[0] ?? state.invalidFields[0] ?? state.conflictFields[0];
    const operationMissing = state.missingFields.includes('operation');
    const reasonCode = operationMissing ? 'operation_missing' : 'parameters_required';
    const expectedOperation = operationMissing ? operations.filter((operation) => action === 'query' ? operation.kind === 'read' : action === 'unknown' || operation.kind === 'action').map((operation) => operation.name).join('|').slice(0, 256) : undefined;
    logParameterBoundary(traceId, {
      stage: 'action.execute', status: 'failed', reasonCode,
      ...(state.pluginId === undefined ? {} : { pluginId: state.pluginId }), functionId: state.functionId,
      fieldState: state.missingFields.length > 0 ? 'missing' : 'invalid',
      ...(fieldName === undefined ? {} : { fieldName }),
      expectedFieldCount: Object.keys(state.presentation ?? {}).length,
      actualFieldCount: Object.keys(state.collected).length,
      missingFieldCount: state.missingFields.length,
      invalidFieldCount: state.invalidFields.length + state.conflictFields.length
    });
    const reply = operationMissing
      ? operationCatalogReply(operations, action)
      : `${parameterCollectionReply(state)}\n${operationCatalogReply(operations, action)}`;
    return { status: 'clarification', reply, reasonCode, collection: state, diagnostic: { reasonCode, ...(expectedOperation === undefined ? {} : { expectedOperation }) } };
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
  private async executePreparedAction(action: ActionDefinition, capabilities: string[], operationKind: 'read' | 'action'): Promise<ExecuteTurnOutcome> {
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
    if (!executed.ok) return this.failedPreparedAction(action, executed.reasonCode, operationKind);
    this.context.workflow.transition({ runId, event: 'complete' });
    await this.context.drainWorkflowEvents();
    return { status: 'executed', action, actionResult: executed.value, operationKind };
  }

  /** 将工作流拒绝映射为待确认或稳定失败结果。
   * confirmation_required 是暂停而非执行成功；其他拒绝不保存动作。
   * @param action - 被策略处理的动作
   * @param reasonCode - 工作流拒绝码
   * @returns 待确认或失败结果
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  private failedPreparedAction(action: ActionDefinition, reasonCode: string, operationKind: 'read' | 'action'): ExecuteTurnOutcome {
    if (reasonCode === 'confirmation_required') {
      this.context.pending = { action };
      const resolved = this.context.pluginHost.resolveCandidate(action.functionId, action.pluginId);
      const descriptor = resolved.ok && resolved.value.manifest.pluginKind === 'business' ? resolved.value.functions.get(action.functionId)?.definition : undefined;
      return { status: 'awaiting_confirmation', action, reply: `即将执行高风险操作「${describeAction(action, descriptor)}」（插件 ${action.pluginId}），需要你的确认。`, operationKind };
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

/** 网关限流缺少确定值时的固定澄清；不复用旧收集状态，避免历史值被误当成本轮授权。 */
function gatewayRateClarificationResult(): ExecuteTurnOutcome {
  return {
    status: 'clarification',
    reply: '请明确限流目标值（例如每秒 150 次），或说明具体的相对调整幅度；“调低一点”、范围和“你看着办”不会直接执行。',
    reasonCode: 'parameters_required',
    diagnostic: { reasonCode: 'parameters_required' }
  };
}

/**
 * 在没有成功事实时，仅解析最近已取消的会话轮次作为只读状态依据。
 *
 * @param reference - 模型声明的历史关系
 * @param history - 有序会话轮次
 * @returns 已取消轮次或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
function resolveCancelledConversationTurn(reference: HistoricalSemanticReference, history: BehaviorContext['conversationTurns']): ConversationTurn | undefined {
  const cancelledTurns = (history?.turns ?? []).filter((turn) => turn.outcome === 'cancelled');
  if (cancelledTurns.length === 0) return undefined;
  const result = resolveOrderedReferenceCandidates({
    items: cancelledTurns.map((turn) => ({ id: turn.turnId, sequence: turn.sequence, turn })),
    ...(history?.focusTurnId === undefined ? {} : { focusId: history.focusTurnId })
  }, orderedReference(reference, 'conversation_turn'));
  return result.status === 'resolved' ? result.item.turn : undefined;
}

/**
 * 将语义帧压缩为可安全记录的字段存在性诊断。
 *
 * @param frame - 通过模型输出 Schema 校验的语义帧
 * @returns 不包含用户原文的语义诊断
 * @author lvdaxianer@yeah.net
 * @date 2026-10-23
 */
function semanticFrameDiagnostic(frame: SemanticFrame): SemanticFrameDiagnostic {
  const hasIntent = frame.intent !== 'unknown';
  const hasAction = frame.action !== 'unknown';
  const missingField = !hasIntent ? 'intent' : !hasAction ? 'action' : undefined;
  return {
    status: 'completed', semanticIntent: frame.intent, semanticAction: frame.action, hasIntent, hasAction,
    ...(missingField === undefined ? { nextStage: 'route.propose' as const } : { missingField, nextStage: 'response.generate' as const })
  };
}

/** 从已注册输入 Schema 中保留运行时报告的字段名，不把未知原因码当成参数。 */
function schemaFields(schema: JsonSchema, fields: readonly string[]): string[] {
  const properties = schema.properties;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return [];
  return fields.filter((field) => Object.hasOwn(properties, field));
}

/** 判断引用是否为新版不透明历史关系。 */
function isHistoricalReference(reference: SemanticFrame['references'][number]): reference is HistoricalSemanticReference {
  return 'relation' in reference;
}

/** 将待解析引用限制在上一次运行时确认的候选集合内。 */
function orderedReference(reference: HistoricalSemanticReference, scope: 'conversation_turn' | 'fact_history'): OrderedReference {
  return {
    scope,
    relation: reference.relation,
    ...(reference.anchorId === undefined ? reference.anchorRecordId === undefined ? {} : { anchorId: reference.anchorRecordId } : { anchorId: reference.anchorId }),
    ...(reference.anchorSequence === undefined ? {} : { anchorSequence: reference.anchorSequence }),
    ...(reference.targetId === undefined ? {} : { targetId: reference.targetId }),
    ...(reference.targetSequence === undefined ? {} : { targetSequence: reference.targetSequence }),
    ...(reference.offset === undefined ? {} : { offset: reference.offset })
  };
}

/** 将待解析引用限制在上一次运行时确认的候选集合内。 */
function restrictToPendingCandidates(history: NonNullable<BehaviorContext['factHistory']> | undefined, pendingReference: PendingReference | undefined): NonNullable<BehaviorContext['factHistory']> | undefined {
  if (history === undefined) return undefined;
  if (pendingReference === undefined) return history;
  const candidateIds = new Set(pendingReference.candidateRecordIds);
  const records = history.records.filter((record) => candidateIds.has(record.recordId));
  const focusRecordId = pendingReference.anchorRecordId && candidateIds.has(pendingReference.anchorRecordId) ? pendingReference.anchorRecordId : undefined;
  return focusRecordId === undefined ? { records } : { records, focusRecordId };
}

/**
 * 相对列表引用优先绑定当前结果批次，避免单会话中“第一个/最后一个”跨场景串到旧事实。
 * 多条 factRecords 通常共享同一个 sourceEventId；单条结果则退回到当前焦点 Function
 * 的连续事实段，从而覆盖同一轮连续创建的两张工单等场景。
 */
function restrictToCurrentFactBatch(history: NonNullable<BehaviorContext['factHistory']>, relation: HistoricalSemanticReference['relation']): NonNullable<BehaviorContext['factHistory']> {
  if (!['first', 'last', 'previous', 'next', 'offset'].includes(relation)) return history;
  const records = [...history.records].sort((left, right) => left.sequence - right.sequence);
  if (records.length <= 1) return history;
  const focusIndex = history.focusRecordId === undefined
    ? records.length - 1
    : records.findIndex((record) => record.recordId === history.focusRecordId);
  const end = focusIndex >= 0 ? focusIndex : records.length - 1;
  const focus = records[end];
  if (focus === undefined) return history;
  const sourceBatch = records.filter((record) => record.sourceEventId === focus.sourceEventId && record.functionId === focus.functionId);
  if (sourceBatch.length > 1) {
    const focusRecordId = history.focusRecordId && sourceBatch.some((record) => record.recordId === history.focusRecordId) ? history.focusRecordId : sourceBatch.at(-1)?.recordId;
    return { records: sourceBatch, ...(focusRecordId === undefined ? {} : { focusRecordId }) };
  }
  let start = end;
  while (start > 0 && records[start - 1]?.functionId === focus.functionId) start -= 1;
  const contiguous = records.slice(start, end + 1);
  if (contiguous.length <= 1) return history;
  const focusRecordId = history.focusRecordId && contiguous.some((record) => record.recordId === history.focusRecordId) ? history.focusRecordId : contiguous.at(-1)?.recordId;
  return { records: contiguous, ...(focusRecordId === undefined ? {} : { focusRecordId }) };
}

/** 把有限候选转换为可持久化的通用待解析引用。 */
function ambiguousReference(reference: HistoricalSemanticReference, candidates: VerifiedFactRecord[]): ReferenceResolution {
  const pendingReference: PendingReference = {
    text: reference.text,
    relation: reference.relation,
    candidateRecordIds: candidates.map((candidate) => candidate.recordId),
    ...((reference.anchorRecordId ?? reference.anchorId) === undefined ? {} : { anchorRecordId: reference.anchorRecordId ?? reference.anchorId }),
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

/** 只接受与当前语义动作类型一致的 nested Function proposal。
 * 连续补全时模型可能沿用默认 read operation；此时回退到本地 Schema/上下文合并，
 * 防止错误 proposal 覆盖用户本轮的 update 或 execute 意图。
 */
function isFunctionCallProposalCompatible(operation: string, action: SemanticFrame['action'], operations: readonly PluginOperation[]): boolean {
  if (action === 'unknown') return true;
  const expectedKind = action === 'query' ? 'read' : 'action';
  return operations.some((item) => item.name === operation && item.kind === expectedKind);
}

/** 只有当前 Function 在目标动作类型下仅有一个 Operation 时才允许 proposal 补齐缺省槽位。 */
function hasGroundedProposalOperation(action: SemanticFrame['action'], operation: string, operations: readonly PluginOperation[], userText: string): boolean {
  const candidate = operations.find((item) => item.name === operation);
  if (candidate === undefined) return action === 'query' && userText.trim().startsWith('candidate-') && operations.every((item) => item.kind === 'read');
  if (action === 'query') return candidate.kind === 'read' && (operations.filter((item) => item.kind === 'read').length === 1 || userText.trim().startsWith('candidate-'));
  if (action === 'unknown' && operations.every((item) => item.kind === 'read') && !isExplicitSideEffectRequest(userText)) return candidate.kind === 'read';
  return operationHasTextEvidence(candidate, userText, action);
}

/** 读取已构建输入中的稳定 Operation 名称。 */
function readOperationName(input: JsonValue): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const operation = (input as Record<string, JsonValue>).operation;
  return typeof operation === 'string' && operation.length > 0 ? operation : undefined;
}

/**
 * 混合读写 Operation 目录中，未被当前输入或同会话证据确认的 read 不得执行。
 *
 * @param context - 当前操作、目录、路由和会话证据
 * @returns 是否需要回到 Operation 澄清
 * @author lvdaxianer@yeah.net
 * @date 2026-10-25
 */
function requiresReadOperationClarification(context: {
  selectedOperation: PluginOperation;
  operations: readonly PluginOperation[];
  behaviorContext: BehaviorContext;
  route: RouteResult;
  userText: string;
  frame: SemanticFrame;
  corroboratedOperation: string | undefined;
}): boolean {
  if (context.selectedOperation.kind !== 'read' || !context.operations.some((operation) => operation.kind === 'action')) return false;
  if (context.corroboratedOperation === context.selectedOperation.name) return false;
  if (operationHasTextEvidence(context.selectedOperation, context.userText, context.frame.action)) return false;
  return !hasVerifiedOperationSelection(context.behaviorContext, context.route.functionId, context.selectedOperation.name);
}

/**
 * 判断 Operation 是否已由同一 Function 的结构化上下文或事实记录确认。
 *
 * @param context - 当前会话的结构化上下文
 * @param functionId - 当前 Function 标识
 * @param operation - 待校验的 Operation
 * @returns 是否存在同一 Function 的已验证选择
 * @author lvdaxianer@yeah.net
 * @date 2026-10-25
 */
function hasVerifiedOperationSelection(context: BehaviorContext, functionId: string | undefined, operation: string): boolean {
  if (functionId === undefined) return false;
  if (context.route.functionId === functionId && context.slots.operation?.value === operation) return true;
  return (context.factHistory?.records ?? []).some((record) => record.functionId === functionId && record.values.operation === operation);
}

/**
 * 生成缺少可信 Operation 时的统一目录澄清结果。
 *
 * @param operations - 当前 Function 已声明的 Operation 目录
 * @param action - 当前语义动作类型
 * @returns 不创建 Action 的澄清结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-25
 */
function operationMissingClarification(operations: readonly PluginOperation[], action: SemanticFrame['action']): ExecuteTurnOutcome {
  const expectedOperation = operations.filter((operation) => action === 'query' ? operation.kind === 'read' : action === 'unknown' || operation.kind === 'action').map((operation) => operation.name).join('|').slice(0, 256);
  return { status: 'clarification', reply: operationCatalogReply(operations, action), reasonCode: 'operation_missing', diagnostic: { reasonCode: 'operation_missing', expectedOperation } };
}

/** 只把非空对象视为模型明确提供了结构化动作参数。 */
function hasStructuredParams(input: JsonValue): boolean {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const params = (input as Record<string, JsonValue>).params;
  return typeof params === 'object' && params !== null && !Array.isArray(params) && Object.keys(params as Record<string, JsonValue>).length > 0;
}

/** 在参数证据不完整或不受支持时，保留 Function/Operation 但丢弃不可验证的参数。 */
function omitParams(input: Record<string, JsonValue>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(input).filter(([field]) => field !== 'params'));
}

/** 仅从同一 Function/Operation 的已验证事实恢复可继续使用的参数。 */
function hasVerifiedOperationParams(context: BehaviorContext, functionId: string | undefined, operation: string | undefined): boolean {
  if (functionId === undefined || operation === undefined) return false;
  return (context.factHistory?.records ?? []).some((record) => {
    if (record.functionId !== functionId || record.values.operation !== operation) return false;
    return Object.keys(record.values).some((field) => field !== 'operation');
  });
}

/** 具体动作请求未命中当前 Operation 目录时，返回不执行的能力边界。 */
function hasSpecificUnmatchedActionRequest(operations: readonly PluginOperation[], userText: string, action: SemanticFrame['action'], behaviorContext: BehaviorContext): boolean {
  if (action === 'query' || action === 'unknown') return false;
  const verifiedOperation = behaviorContext.slots.operation?.value;
  if (typeof verifiedOperation === 'string' && verifiedOperation.length > 0) return false;
  if ((behaviorContext.factHistory?.records.length ?? 0) > 0 && /(?:上调|下调|提高|降低|增加|减少)\s*\d/iu.test(userText)) return false;
  // Generic action wording such as “update” is not enough to prove which
  // Operation the user requested; only operation-specific evidence may keep
  // this request inside the declared catalog.
  if (operations.some((operation) => operationHasTextEvidence(operation, userText))) return false;
  return /\d|百分比|范围|规则|配置|订阅|清除|暂停|删除|开通|导出|新建/u.test(userText);
}

/** 当 Operation 描述声明多个可选目标且当前动作未提供任何描述内目标时继续收集参数。 */
function operationNeedsDescribedTarget(operation: PluginOperation, userText: string, action: SemanticFrame['action']): boolean {
  if (action === 'query' || action === 'unknown' || !/(?:或|或者)/u.test(operation.description)) return false;
  const body = operation.description.replace(/^(?:查看|检索|查询|列出|获取|调整|修改|设置|提交|创建|导出|重跑|停止|转接|申请|删除|执行|运行)/u, '');
  const alternatives = body.match(/([\p{Script=Han}]{2,8})\s*或(?:者)?\s*([\p{Script=Han}]{2,8})/u);
  if (alternatives === null) return false;
  const tokens = alternatives.slice(1).flatMap((part) => Array.from(part?.matchAll(/[\p{Script=Han}]{2}/gu) ?? [], (match) => match[0]));
  return tokens.length > 0 && !tokens.some((token) => userText.includes(token));
}

/** 能力目录不包含当前请求时的稳定、不可执行结果。 */
function unsupportedOperationResult(): ExecuteTurnOutcome {
  return { status: 'clarification', reply: '当前请求不在已声明的 Operation 能力范围内，无法执行；请从当前能力目录中选择支持的操作，或补充一个可用目标。', reasonCode: 'operation_unsupported' };
}

/** 将当前 Function 的有限 Operation 目录转换为用户可选择的澄清。 */
function operationCatalogReply(operations: readonly PluginOperation[], action: SemanticFrame['action']): string {
  const options = operations.filter((operation) => action === 'query' ? operation.kind === 'read' : action === 'unknown' || operation.kind === 'action').slice(0, 5);
  if (options.length === 0) return '当前 Function 没有可用的操作，请补充明确的目标或换一种说法。';
  const lines = options.map((operation) => `- ${operation.name}：${operation.description.slice(0, 120)}`);
  return `已识别目标 Function，但还缺少具体操作。请从以下操作中选择一个：\n${lines.join('\n')}\n未列出的 Operation 不在当前能力范围内，不会执行。`;
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

/**
 * 将模型语义限制在用户已选择的当前候选范围内，不直接创建 Action。
 *
 * @param frame - 已通过语义契约校验的模型帧
 * @param descriptor - 当前已验证且已授权的 Function 描述
 * @returns 保留合法动作、唯一恢复动作或 unknown 的语义帧
 */
export function constrainFrame(frame: SemanticFrame, descriptor: PluginDescriptor): SemanticFrame {
  const action = frame.action !== 'unknown'
    ? (descriptor.actionTypes.includes(frame.action as ActionType) ? frame.action : 'unknown')
    : descriptor.actionTypes.length === 1 ? descriptor.actionTypes[0] ?? 'unknown' : 'unknown';
  return { ...frame, intent: descriptor.functionId, action };
}
