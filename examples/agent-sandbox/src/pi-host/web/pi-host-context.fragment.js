  /** 构建可复制的 Pi Host 调试快照；字段采用白名单而不是复制页面对象。
   * @param input - 页面当前的调试状态
   * @returns 版本化且脱敏的结构化上下文
   * @author lvdaxianer@yeah.net
   * @date 2026-10-22
   */
  function buildPiHostContextSnapshot(input) {
    var state = input && typeof input === 'object' ? input : {};
    return {
      schemaVersion: 'iar.pi-host-context/v1',
      generatedAt: new Date().toISOString(),
      session: pickPiHostContextSession(state.session),
      route: pickPiHostContextRoute(state.route),
      timing: pickPiHostContextTiming(state.timing),
      pending: pickPiHostContextPending(state.pending),
      structuredContext: pickPiHostStructuredContext(state.structuredContext),
      workflowState: pickPiHostWorkflowState(state.workflowState),
      events: Array.isArray(state.events) ? state.events.map(pickPiHostContextEvent) : [],
    };
  }

  /** 复制 Bridge 的安全结构化上下文，排除消息正文、槽位值和确认凭据。
   * @param context - Bridge state 中的结构化上下文
   * @returns 可复制的结构化上下文
   * @author lvdaxianer@yeah.net
   * @date 2026-10-24
   */
  function pickPiHostStructuredContext(context) {
    var value = context && typeof context === 'object' ? context : {};
    var result = {
      schemaVersion: contextValue(value.schemaVersion),
      subject: pickPiHostStructuredSubject(value.subject),
      intent: contextValue(value.intent),
      action: pickPiHostStructuredAction(value.action),
      route: pickPiHostStructuredRoute(value.route),
      slots: pickPiHostStructuredSlots(value.slots),
      workflow: pickPiHostStructuredWorkflow(value.workflow),
      pending: pickPiHostStructuredPending(value.pending),
      confirmation: { state: contextValue(value.confirmation && value.confirmation.state) },
      factHistory: pickPiHostStructuredFactHistory(value.factHistory),
      conversationTurns: pickPiHostStructuredTurns(value.conversationTurns),
      integrity: { criticalFieldHash: contextValue(value.integrity && value.integrity.criticalFieldHash), lastEventId: contextValue(value.integrity && value.integrity.lastEventId) },
    };
    if (value.routingScope && typeof value.routingScope === 'object') result.routingScope = pickPiHostStructuredRoutingScope(value.routingScope);
    if (value.clarification && typeof value.clarification === 'object') result.clarification = pickPiHostStructuredClarification(value.clarification);
    if (value.collection && typeof value.collection === 'object') result.collection = pickPiHostStructuredCollection(value.collection);
    if (value.pendingReference && typeof value.pendingReference === 'object') result.pendingReference = pickPiHostStructuredPendingReference(value.pendingReference);
    if (value.summary && typeof value.summary === 'object') result.summary = { version: contextValue(value.summary.version), eventId: contextValue(value.summary.eventId) };
    return result;
  }

  /**
   * 复制结构化上下文中的主语摘要。
   * @param subject - 结构化上下文主语
   * @returns 安全主语摘要
   * @author lvdaxianer@yeah.net
   * @date 2026-10-24
   */
  function pickPiHostStructuredSubject(subject) { var value = subject && typeof subject === 'object' ? subject : {}; return { type: contextValue(value.type), id: contextValue(value.id), status: contextValue(value.status), source: contextValue(value.source), sourceEventId: contextValue(value.sourceEventId) }; }

  /**
   * 复制结构化上下文中的动作摘要。
   * @param action - 结构化上下文动作
   * @returns 安全动作摘要
   * @author lvdaxianer@yeah.net
   * @date 2026-10-24
   */
  function pickPiHostStructuredAction(action) { var value = action && typeof action === 'object' ? action : {}; return { name: contextValue(value.name), status: contextValue(value.status) }; }

  /**
   * 复制结构化上下文中的路由标识。
   * @param route - 结构化上下文路由
   * @returns 安全路由标识
   * @author lvdaxianer@yeah.net
   * @date 2026-10-24
   */
  function pickPiHostStructuredRoute(route) { var value = route && typeof route === 'object' ? route : {}; return { functionId: contextValue(value.functionId), pluginId: contextValue(value.pluginId) }; }

  /**
   * 复制字段状态，明确丢弃每个 slot 的 value。
   * @param slots - 结构化上下文字段状态
   * @returns 不含字段值的槽位映射
   * @author lvdaxianer@yeah.net
   * @date 2026-10-24
   */
  function pickPiHostStructuredSlots(slots) { var value = slots && typeof slots === 'object' ? slots : {}; return Object.fromEntries(Object.entries(value).map(function (entry) { var slot = entry[1] && typeof entry[1] === 'object' ? entry[1] : {}; return [entry[0], { status: contextValue(slot.status), sourceEventId: contextValue(slot.sourceEventId) }]; })); }

  /**
   * 复制结构化工作流位置。
   * @param workflow - 结构化上下文工作流
   * @returns 安全工作流摘要
   * @author lvdaxianer@yeah.net
   * @date 2026-10-24
   */
  function pickPiHostStructuredWorkflow(workflow) { var value = workflow && typeof workflow === 'object' ? workflow : {}; return { workflowId: contextValue(value.workflowId), currentStep: contextValue(value.currentStep), status: contextValue(value.status) }; }

  /**
   * 复制当前等待输入的类型和状态。
   * @param pending - 当前 pending 摘要
   * @returns 安全 pending 摘要
   * @author lvdaxianer@yeah.net
   * @date 2026-10-24
   */
  function pickPiHostStructuredPending(pending) { var value = pending && typeof pending === 'object' ? pending : {}; return { kind: contextValue(value.kind), status: contextValue(value.status) }; }

  /**
   * 复制路由范围标识和动作类型。
   * @param scope - 当前路由范围
   * @returns 安全路由范围摘要
   * @author lvdaxianer@yeah.net
   * @date 2026-10-24
   */
  function pickPiHostStructuredRoutingScope(scope) { return { activePluginId: contextValue(scope.activePluginId), candidatePluginIds: pickPiHostContextStringArray(scope.candidatePluginIds), actionTypes: pickPiHostContextStringArray(scope.actionTypes), continuation: contextValue(scope.continuation) }; }

  /**
   * 复制澄清状态和不透明候选键。
   * @param clarification - 当前澄清状态
   * @returns 安全澄清摘要
   * @author lvdaxianer@yeah.net
   * @date 2026-10-24
   */
  function pickPiHostStructuredClarification(clarification) { return { mode: contextValue(clarification.mode), unresolvedStreak: contextNumber(clarification.unresolvedStreak), reasonCode: contextValue(clarification.reasonCode), candidateVersion: contextValue(clarification.candidateVersion), candidateKeys: pickPiHostContextStringArray(clarification.candidateKeys) }; }

  /**
   * 复制参数收集的字段状态，不复制 collected 值或展示选项正文。
   * @param collection - 当前参数收集状态
   * @returns 安全收集摘要
   * @author lvdaxianer@yeah.net
   * @date 2026-10-24
   */
  function pickPiHostStructuredCollection(collection) { return { kind: contextValue(collection.kind), functionId: contextValue(collection.functionId), pluginId: contextValue(collection.pluginId), candidateFunctionCount: contextNumber(collection.candidateFunctionCount), schemaVersion: contextValue(collection.schemaVersion), collectedFields: pickPiHostContextStringArray(collection.collectedFields), missingFields: pickPiHostContextStringArray(collection.missingFields), invalidFields: pickPiHostContextStringArray(collection.invalidFields), conflictFields: pickPiHostContextStringArray(collection.conflictFields), presentationFields: pickPiHostContextStringArray(collection.presentationFields), candidateKeys: pickPiHostContextStringArray(collection.candidateKeys) }; }

  /**
   * 复制待解析引用关系，排除引用原文。
   * @param reference - 当前待解析引用
   * @returns 安全引用摘要
   * @author lvdaxianer@yeah.net
   * @date 2026-10-24
   */
  function pickPiHostStructuredPendingReference(reference) { return { relation: contextValue(reference.relation), anchorRecordId: contextValue(reference.anchorRecordId), offset: contextNumber(reference.offset), candidateRecordIds: pickPiHostContextStringArray(reference.candidateRecordIds) }; }

  /**
   * 复制有界已验证事实及其公开原子值。
   * @param history - 当前事实历史
   * @returns 安全事实历史
   * @author lvdaxianer@yeah.net
   * @date 2026-10-24
   */
  function pickPiHostStructuredFactHistory(history) { var value = history && typeof history === 'object' ? history : {}; var records = Array.isArray(value.records) ? value.records.map(pickPiHostStructuredFactRecord) : []; return { records: records, focusRecordId: contextValue(value.focusRecordId) }; }

  /**
   * 复制单条事实的来源和公开值。
   * @param record - 单条事实记录
   * @returns 安全事实记录
   * @author lvdaxianer@yeah.net
   * @date 2026-10-24
   */
  function pickPiHostStructuredFactRecord(record) { var value = record && typeof record === 'object' ? record : {}; return { recordId: contextValue(value.recordId), sequence: contextNumber(value.sequence), sourceEventId: contextValue(value.sourceEventId), functionId: contextValue(value.functionId), pluginId: contextValue(value.pluginId), values: pickPiHostStructuredFactValues(value.values), createdAt: contextValue(value.createdAt) }; }

  /**
   * 只保留事实信封声明的原子值。
   * @param values - 事实值映射
   * @returns 安全原子值映射
   * @author lvdaxianer@yeah.net
   * @date 2026-10-24
   */
  function pickPiHostStructuredFactValues(values) { var value = values && typeof values === 'object' ? values : {}; return Object.fromEntries(Object.entries(value).filter(function (entry) { return entry[1] === null || ['string', 'number', 'boolean'].includes(typeof entry[1]); })); }

  /**
   * 复制轮次顺序和结果元数据，排除 userText 与 assistantText。
   * @param history - 当前轮次历史
   * @returns 安全轮次元数据
   * @author lvdaxianer@yeah.net
   * @date 2026-10-24
   */
  function pickPiHostStructuredTurns(history) { var value = history && typeof history === 'object' ? history : {}; var turns = Array.isArray(value.turns) ? value.turns.map(function (turn) { return { turnId: contextValue(turn && turn.turnId), sequence: contextNumber(turn && turn.sequence), outcome: contextValue(turn && turn.outcome), actionTaken: Boolean(turn && turn.actionTaken), completedAt: contextValue(turn && turn.completedAt) }; }) : []; return { turns: turns, focusTurnId: contextValue(value.focusTurnId) }; }

  /**
   * 复制安全 Workflow 状态，不复制确认 scope 或参数值。
   * @param workflow - Bridge Workflow state
   * @returns 安全 Workflow 状态
   * @author lvdaxianer@yeah.net
   * @date 2026-10-24
   */
  function pickPiHostWorkflowState(workflow) { var value = workflow && typeof workflow === 'object' ? workflow : {}; return { mapVersion: contextValue(value.mapVersion), currentState: contextValue(value.currentState), activeState: contextValue(value.activeState), outcome: contextValue(value.outcome), workflowStatus: contextValue(value.workflowStatus), allowedEvents: pickPiHostContextStringArray(value.allowedEvents), pending: pickPiHostStructuredPending(value.pending), confirmation: { state: contextValue(value.confirmation && value.confirmation.state) }, route: pickPiHostStructuredRoute(value.route), collection: value.collection && typeof value.collection === 'object' ? pickPiHostStructuredCollection(value.collection) : undefined }; }

  /**
   * 复制有限字符串数组并过滤非字符串项。
   * @param values - 待复制字符串数组
   * @returns 安全字符串数组
   * @author lvdaxianer@yeah.net
   * @date 2026-10-24
   */
  function pickPiHostContextStringArray(values) { return Array.isArray(values) ? values.filter(function (value) { return typeof value === 'string' && value; }) : []; }

  /** 复制会话摘要，明确排除连接凭证等非展示字段。
   * @param session - 页面记录的会话信息
   * @returns 安全会话摘要
   * @author lvdaxianer@yeah.net
   * @date 2026-10-22
   */
  function pickPiHostContextSession(session) {
    var value = session && typeof session === 'object' ? session : {};
    return { sessionId: contextValue(value.sessionId), mode: contextValue(value.mode), bridgeUrl: contextValue(value.bridgeUrl) };
  }

  /** 复制路由公共字段，不把自然语言意图或请求正文带入快照。
   * @param route - 页面记录的路由摘要
   * @returns 安全路由摘要
   * @author lvdaxianer@yeah.net
   * @date 2026-10-22
   */
  function pickPiHostContextRoute(route) {
    var value = route && typeof route === 'object' ? route : {};
    return { functionId: contextValue(value.functionId), pluginId: contextValue(value.pluginId), disposition: contextValue(value.disposition), operationKind: contextValue(value.operationKind), replySource: contextValue(value.replySource) };
  }

  /** 复制计时与阶段摘要，只保留诊断所需的数值字段。
   * @param timing - 页面记录的计时摘要
   * @returns 安全计时摘要
   * @author lvdaxianer@yeah.net
   * @date 2026-10-22
   */
  function pickPiHostContextTiming(timing) {
    var value = timing && typeof timing === 'object' ? timing : {};
    var stages = Array.isArray(value.stages) ? value.stages.map(pickPiHostContextStage) : [];
    return { traceId: contextValue(value.traceId), durationMs: contextNumber(value.durationMs), stages: stages };
  }

  /** 复制单个阶段的安全耗时字段。
   * @param stage - 页面记录的阶段摘要
   * @returns 安全阶段摘要
   * @author lvdaxianer@yeah.net
   * @date 2026-10-22
   */
  function pickPiHostContextStage(stage) {
    var value = stage && typeof stage === 'object' ? stage : {};
    return { stage: contextValue(value.stage), durationMs: contextNumber(value.durationMs), firstTokenMs: contextNumber(value.firstTokenMs) };
  }

  /** 复制待确认动作的标识和风险摘要，不复制动作 input。
   * @param pending - 页面记录的待确认摘要
   * @returns 安全待确认摘要或 null
   * @author lvdaxianer@yeah.net
   * @date 2026-10-22
   */
  function pickPiHostContextPending(pending) {
    if (!pending || typeof pending !== 'object') return null;
    return { actionId: contextValue(pending.actionId), runId: contextValue(pending.runId), functionId: contextValue(pending.functionId), pluginId: contextValue(pending.pluginId), riskLevel: contextValue(pending.riskLevel) };
  }

  /** 复制事件标签；通知正文可能含业务内容，因此只保留事件类型。
   * @param event - 页面最近事件
   * @returns 安全事件摘要
   * @author lvdaxianer@yeah.net
   * @date 2026-10-22
   */
  function pickPiHostContextEvent(event) {
    var value = event && typeof event === 'object' ? event : {};
    return { name: contextValue(value.name), detail: value.name === '通知' ? '-' : contextValue(value.detail) };
  }

  /** 将调试字符串字段归一化为占位符，避免复制 undefined。
   * @param value - 待复制的字符串字段
   * @returns 安全字符串或占位符
   * @author lvdaxianer@yeah.net
   * @date 2026-10-22
   */
  function contextValue(value) { return typeof value === 'string' && value ? value : '-'; }

  /** 将计时字段归一化为 null，避免把异常值误认为真实耗时。
   * @param value - 待复制的计时字段
   * @returns 有限数值或 null
   * @author lvdaxianer@yeah.net
   * @date 2026-10-22
   */
  function contextNumber(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
