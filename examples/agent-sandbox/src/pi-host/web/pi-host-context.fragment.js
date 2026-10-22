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
      events: Array.isArray(state.events) ? state.events.map(pickPiHostContextEvent) : [],
    };
  }

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
