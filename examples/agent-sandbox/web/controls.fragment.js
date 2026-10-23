  let lastReplySource = null;
  let latestState = null;

  /** 展示确认结果并写入本地历史，三种终态对应原有展示文案。
   * 执行与取消共用动作标识，结果文字直接来自服务端响应。
   * @param confirmResult - 服务端确认终态
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function reportConfirmResult(confirmResult) {
    var meta = confirmResult.status === 'executed' ? '已执行' : confirmResult.status === 'cancelled' ? '已取消' : '失败';
    var reply = confirmResult.reply || '操作失败';
    appendMsg('bot', reply, meta);
    recordConversation('bot', reply, meta);
  }

  /** 确认或取消本会话中的待确认动作。
   * 回调只闭包保存用户实际看到的动作，而非稍后读取的新快照。
   * 相同动作已显示时不重复创建控件；新动作替换旧确认框。
   * 提交携带展示给用户的 actionId，由服务端在会话队列中校验。
   * 网络失败不能证明动作未执行，因此提示检查状态而不重试。
   * 状态刷新结束前维持忙碌，防止旧动作再次被点击。
   * 取消与执行共用同一动作标识，不能取消后续新动作。
   * 结果中的执行、取消和失败分别显示在消息尾部。
   * 无论请求是否成功，finally 都会恢复允许的控件状态。
   * @param pending - 当前快照中的待确认动作
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  function runConfirm(pending) {
    if (pendingRunId === pending.actionId) return;
    document.querySelectorAll('.confirm-box').forEach(function (box) { box.remove(); });
    pendingRunId = pending.actionId;
    showConfirmBox(pending, function (accepted) {
      pendingRunId = null;
      setBusy(true);
      api('/confirm', { accepted: accepted, actionId: pending.actionId }).then(function (confirmResult) {
        reportConfirmResult(confirmResult);
        return refreshState();
      }).catch(function () { if (!sessionExpired) appendMsg('bot', '确认请求失败，结果可能未知；请检查状态后再操作。', '失败'); }).finally(function () { setBusy(false); });
    });
  }

  /** 提交用户消息并等待流与状态刷新结束。
   * 发送期间禁用所有变更入口，防止旧确认框被操作。
   * 输入文本保留在闭包中，网络失败时恢复到输入框。
   * 即便连接失败也先刷新状态，不能自动重发可能已经执行的动作。
   * 空白输入不会发送，也不会改变本地聊天记录。
   * 会话未就绪或失效时直接拒绝提交。
   * 本地先显示用户消息，后续回复由 SSE 气泡显示。
   * 错误说明避免断言服务端一定未执行。
   * 发送与确认、压缩、重置共享一个页面忙碌状态。
   * 用户主动重试前可以在右侧查看重新拉取的状态。
   * 提交回调阻止表单默认导航，保持当前标签页会话。
   * 结束时重新应用会话就绪及过期状态，不能无条件启用控件。
   * 输入框只在有效非空消息提交后清空。
   * 服务端最终结果以 SSE done 事件为准。
   * 发送路径使用初始化时为当前标签页独占的会话。
   * @param event - 浏览器表单提交事件
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  document.getElementById('inputBar').onsubmit = function (event) {
    event.preventDefault();
    if (!sessionReady || sessionBusy || sessionExpired) return;
    var text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    appendMsg('user', text);
    recordConversation('user', text);
    setBusy(true);
    streamChat(text)
      .catch(function () {
        inputEl.value = text;
        if (!sessionExpired) appendMsg('bot', '请求未完成，结果可能未知；请检查状态后再重试。', '失败');
      })
      .then(function () {
        return refreshState();
      }).finally(function () { setBusy(false); });
  };

  /** 请求上下文压缩并展示结果及关键字段哈希。
   * 压缩是会话内串行操作，失败时保留当前界面状态。
   * 状态读取也处于忙碌期，避免确认框在尚未同步时可点击。
   * 成功时同时展示摘要和前后哈希，供用户核对压缩效果。
   * 失败时展示原因码，并提示关键字段哈希保持不变。
   * 连接异常只提示检查状态，不重新发起压缩。
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  document.getElementById('compactBtn').onclick = function () {
    if (!sessionReady || sessionBusy || sessionExpired) return;
    setBusy(true);
    api('/compact').then(function (result) {
      var el = document.getElementById('compactResult');
      el.className = 'show ' + (result.ok ? 'ok' : 'fail');
      if (result.ok) {
        el.textContent = '压缩成功：' + (result.summary || '') + '（哈希 ' + result.hashBefore.slice(0, 12) + '… → ' + result.hashAfter.slice(0, 12) + '…）';
      } else {
        el.textContent = '压缩失败：' + (result.reasonCode || '') + ' ' + (result.error || '') + '（哈希保持不变）';
      }
      return refreshState();
    }).catch(function () { if (!sessionExpired) appendMsg('bot', '压缩请求失败，请检查状态后重试。', '失败'); }).finally(function () { setBusy(false); });
  };

  /** 经用户确认后重置当前会话。
   * 重置清除事件及待确认动作；取消确认时不发出请求。
   * 只有服务成功响应后才清除本地消息和压缩结果。
   * 状态刷新完成之前持续禁止并发操作。
   * 本地 pending 标识一并清除，刷新时再读取服务端事实。
   * 本地历史随重置一并清理，避免旧记录被切回时回放。
   * 网络错误保留既有画面，避免暗示服务端一定没有重置。
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  document.getElementById('resetBtn').onclick = function () {
    if (!sessionReady || sessionBusy || sessionExpired || !confirm('重置将清除当前会话状态，确定继续吗？')) return;
    setBusy(true);
    api('/reset').then(function () {
      clearConversation(sessionId);
      messagesEl.innerHTML = '';
      pendingRunId = null;
      lastReplySource = null;
      latestState = null;
      latestTimingSummary = null;
      document.getElementById('routeReplySource').textContent = '-';
      document.getElementById('timingTotal').textContent = '-';
      document.getElementById('timingTraceId').textContent = '-';
      document.getElementById('timingList').innerHTML = '';
      appendMsg('bot', '会话已重置，开始新的对话吧。');
      recordConversation('bot', '会话已重置，开始新的对话吧。');
      document.getElementById('compactResult').className = '';
      return refreshState();
    }).catch(function () { if (!sessionExpired) appendMsg('bot', '重置请求失败，请检查状态后重试。', '失败'); })
      .finally(function () { setBusy(false); });
  };

  /** 新会话建立后的收尾：释放旧锁、重建画面并同步状态与列表。
   * 欢迎消息同时写入本地历史，切回该会话时仍可见建立提示。
   * @param oldLease - 上一个会话的锁租约
   * @returns 状态刷新完成的 Promise
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function finishNewSession(oldLease) {
    sessionReady = true;
    if (oldLease) oldLease.release();
    messagesEl.innerHTML = '';
    pendingRunId = null;
    lastReplySource = null;
    latestState = null;
    latestTimingSummary = null;
    document.getElementById('routeReplySource').textContent = '-';
    document.getElementById('timingTotal').textContent = '-';
    document.getElementById('timingTraceId').textContent = '-';
    document.getElementById('timingList').innerHTML = '';
    document.getElementById('compactResult').className = '';
    appendMsg('bot', '新会话已建立，原会话已保留在会话列表中。');
    recordConversation('bot', '新会话已建立，原会话已保留在会话列表中。');
    refreshSessionList();
    return refreshState();
  }

  /** 经用户确认后新建独立会话并清空本地画面。
   * 旧服务端会话保留在会话列表中，可随时切回继续提问。
   * 先清本地恢复凭据，复用初始化逻辑走新建路径。
   * 旧锁在新会话建立后释放，避免窗口期无锁可恢复。
   * 新会话就绪后才重建欢迎消息并同步状态面板与会话列表。
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  document.getElementById('newSessionBtn').onclick = function () {
    if (!sessionReady || sessionBusy || sessionExpired) return;
    if (!confirm('新建会话将保留当前会话（可在会话列表切回），确定继续吗？')) return;
    setBusy(true);
    sessionReady = false;
    var oldLease = sessionLease;
    sessionId = null;
    sessionLease = null;
    try { sessionStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(RELOAD_KEY); sessionStorage.removeItem(TAB_KEY); } catch (err) { /* 尽力清理，失败时初始化仍会新建。 */ }
    Promise.resolve().then(initializeSession).then(function () { return finishNewSession(oldLease); })
      .then(function () { setBusy(false); }).catch(function () {
        setBusy(false);
        if (!sessionExpired) appendMsg('bot', '新建会话失败，请刷新页面重试。', '失败');
      });
  };

  /** 拉取当前会话快照并同步调试面板及待确认动作。
   * 周期刷新失败不重复弹错；会话失效由响应检查统一处理。
   * 初始化前和会话失效后不发送状态请求。
   * refreshState 返回 Promise，使调用方可以等待控件状态同步。
   * 拉取期间如出现失效响应，过期处理会清除本地会话标识。
   * @returns 状态刷新完成的 Promise
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  function refreshState() {
    if (!sessionReady || sessionExpired) return Promise.resolve();
    return sessionFetch('/state').then(function (res) { return res.json(); }).then(renderState)
      .catch(function () { /* 状态轮询失败不重复输出提示；过期由入口统一提示。 */ });
  }

  /** 更新确认框和右侧会话状态。
   * 没有 pending 时移除旧确认框，不能让旧动作继续可操作。
   * 新建确认按钮读取当前忙碌状态，不会在状态刷新中提前启用。
   * 模式、路由和上下文均使用纯文本显示。
   * mode badge 区分真实模型和离线演示，避免误解运行方式。
   * 缺失的路由和意图使用占位符，不猜测服务端结果。
   * 状态面板显示服务端快照，不作为动作确认的授权凭据。
   * @param state - 服务端当前会话快照
   * @returns 无返回值
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  function renderState(state) {
    latestState = state;
    if (state.pending) runConfirm(state.pending);
    else { pendingRunId = null; document.querySelectorAll('.confirm-box').forEach(function (box) { box.remove(); }); }
    var badge = document.getElementById('modeBadge');
    badge.textContent = state.mode === 'brain' ? 'brain real · 真实 LLM' : 'brain scripted · 离线假大脑';
    badge.className = 'badge' + (state.mode === 'brain' ? '' : ' scripted');
    var route = state.context.route || {};
    document.getElementById('routeFunction').textContent = route.functionId || '-';
    document.getElementById('routePlugin').textContent = route.pluginId || '-';
    document.getElementById('routeStatus').textContent = state.context.workflow.status + ' / ' + state.context.workflow.currentStep;
    document.getElementById('routeReplySource').textContent = lastReplySource || '-';
    document.getElementById('routeConfidence').textContent = state.context.intent && state.context.intent !== 'unknown' ? state.context.intent : '-';
    var score = state.context.action && state.context.action.name !== 'unknown' ? state.context.action.name + '（' + state.context.action.status + '）' : '-';
    document.getElementById('routeScore').textContent = score;
    document.getElementById('contextJson').textContent = JSON.stringify(state.context, null, 2);
    renderCollection(state.context.collection);
    renderEvents(state.events);
  }

  /**
   * 将当前会话快照裁剪为可复制的结构化调试上下文。
   * @param state - 当前页面状态
   * @returns 不含正文和授权字段的结构化快照
   * @author lvdaxianer@yeah.net
   * @date 2026-10-23
   */
  function buildStructuredContextSnapshot(state) {
    var context = state && state.context ? state.context : {};
    return { traceId: latestTimingSummary && latestTimingSummary.traceId || null, route: pickRoute(context.route), collection: context.collection || null, timing: latestTimingSummary || null };
  }

  /**
   * 复制结构化上下文所需的路由字段，避免把正文或授权字段带出页面。
   * @param route - 当前页面路由状态
   * @returns 白名单路由摘要
   * @author lvdaxianer@yeah.net
   * @date 2026-10-23
   */
  function pickRoute(route) {
    var source = route && typeof route === 'object' ? route : {};
    var keys = ['functionId', 'pluginId', 'operationKind', 'status', 'reasonCode', 'semanticIntent', 'semanticConfidence', 'missingField', 'expectedOperation', 'actualOperation'];
    return keys.reduce(function (result, key) { if (source[key] !== undefined) result[key] = source[key]; return result; }, {});
  }

  /**
   * 通过浏览器剪贴板复制有界 JSON，失败时给出可重试提示。
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-23
   */
  function copyStructuredContext() {
    var status = document.getElementById('copyContextStatus');
    if (!latestState) { status.textContent = '暂无可复制的会话上下文。'; return; }
    if (!navigator.clipboard || !navigator.clipboard.writeText) { status.textContent = '当前浏览器不支持剪贴板，请手动查看 BehaviorContext。'; return; }
    var text = JSON.stringify(buildStructuredContextSnapshot(latestState), null, 2);
    navigator.clipboard.writeText(text).then(function () { status.textContent = '结构化上下文已复制。'; }).catch(function () { status.textContent = '复制失败，请检查浏览器剪贴板权限后重试。'; });
  }

  /**
   * 根据服务端收集状态渲染通用参数表单，不解释 Function 的业务含义。
   * @param collection - 服务端收集状态
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-23
   */
  function renderCollection(collection) {
    var panel = document.getElementById('collectionPanel');
    panel.innerHTML = '';
    if (!collection) { panel.textContent = '当前没有待收集参数。'; return; }
    if (collection.kind === 'function') { renderFunctionCollection(panel, collection); return; }
    if (collection.kind === 'parameters') renderParameterCollection(panel, collection);
  }

  /**
   * 展示 Function 候选状态，候选仅作为不透明标识显示。
   * @param panel - 收集面板节点
   * @param collection - Function 收集状态
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-23
   */
  function renderFunctionCollection(panel, collection) {
    var title = document.createElement('div');
    title.className = 'collection-status';
    title.textContent = collection.reasonCode === 'function_ambiguous' ? '请从候选 Function 中选择：' : '当前还不能唯一确定 Function：';
    panel.appendChild(title);
    (collection.candidateFunctionIds || []).forEach(function (id) { appendCodeItem(panel, id); });
  }

  /**
   * 为 Function 候选创建安全的代码标识行。
   * @param panel - 收集面板节点
   * @param value - 不透明 Function 标识
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-23
   */
  function appendCodeItem(panel, value) {
    var item = document.createElement('code');
    item.className = 'collection-code';
    item.textContent = value;
    panel.appendChild(item);
  }

  /**
   * 按 Schema 展示当前缺失、非法或冲突的字段。
   * @param panel - 收集面板节点
   * @param collection - 参数收集状态
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-23
   */
  function renderParameterCollection(panel, collection) {
    var form = document.createElement('form');
    form.className = 'collection-form';
    var title = document.createElement('div');
    title.className = 'collection-status';
    title.textContent = '请补充参数：' + collection.functionId;
    form.appendChild(title);
    collectionFields(collection).forEach(function (field) { form.appendChild(createCollectionField(collection, field)); });
    var submit = document.createElement('button');
    submit.type = 'submit'; submit.textContent = '提交参数';
    form.appendChild(submit);
    form.onsubmit = function (event) { event.preventDefault(); submitCollection(form, collection); };
    panel.appendChild(form);
  }

  /**
   * 合并缺失、非法、冲突字段并保持页面字段数量有界。
   * @param collection - 参数收集状态
   * @returns 去重后的字段名
   * @author lvdaxianer@yeah.net
   * @date 2026-10-23
   */
  function collectionFields(collection) {
    return (collection.missingFields || []).concat(collection.invalidFields || [], collection.conflictFields || []).filter(function (field, index, fields) { return fields.indexOf(field) === index; }).slice(0, 32);
  }

  /**
   * 创建单个通用字段控件，标签来自服务端 Schema 展示元数据。
   * @param collection - 参数收集状态
   * @param field - Schema 字段名
   * @returns 字段标签节点
   * @author lvdaxianer@yeah.net
   * @date 2026-10-23
   */
  function createCollectionField(collection, field) {
    var meta = collection.presentation && collection.presentation[field] || {};
    var label = document.createElement('label'); label.className = 'collection-field';
    var caption = document.createElement('span'); caption.textContent = meta.label || field; label.appendChild(caption);
    if (meta.description) { var help = document.createElement('small'); help.className = 'collection-help'; help.textContent = meta.description; label.appendChild(help); }
    label.appendChild(createCollectionControl(meta, field, collection.collected && collection.collected[field]));
    return label;
  }

  /**
   * 由控件元数据创建文本、数值、布尔、枚举或 JSON 输入。
   * @param meta - 服务端 Schema 展示元数据
   * @param field - Schema 字段名
   * @param value - 已收集值
   * @returns 输入控件节点
   * @author lvdaxianer@yeah.net
   * @date 2026-10-23
   */
  function createCollectionControl(meta, field, value) {
    var control = meta.control || 'text';
    if (control === 'boolean') { var checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.name = field; checkbox.checked = value === true; checkbox.dataset.collectionControl = control; return checkbox; }
    if (control === 'object') return collectionTextarea(field, value);
    if (control === 'select' || control === 'multi-select') return collectionSelect(meta.options || [], field, value, control === 'multi-select');
    var input = document.createElement('input'); input.name = field; input.type = control === 'number' ? 'number' : 'text'; input.value = value === undefined ? '' : String(value); input.dataset.collectionControl = control; return input;
  }

  /**
   * 创建对象字段的 JSON 文本框。
   * @param field - Schema 字段名
   * @param value - 已收集对象值
   * @returns JSON 文本框节点
   * @author lvdaxianer@yeah.net
   * @date 2026-10-23
   */
  function collectionTextarea(field, value) {
    var textarea = document.createElement('textarea'); textarea.name = field; textarea.rows = 3; textarea.value = value === undefined ? '' : JSON.stringify(value); textarea.dataset.collectionControl = 'object'; return textarea;
  }

  /**
   * 创建枚举或多选控件，选项值严格来自服务端 Schema。
   * @param options - 服务端提供的有限选项
   * @param field - Schema 字段名
   * @param value - 已收集值
   * @param multiple - 是否允许多选
   * @returns 选择控件节点
   * @author lvdaxianer@yeah.net
   * @date 2026-10-23
   */
  function collectionSelect(options, field, value, multiple) {
    var select = document.createElement('select'); select.name = field; select.multiple = multiple; select.dataset.collectionControl = multiple ? 'multi-select' : 'select';
    var values = Array.isArray(value) ? value : [value];
    options.forEach(function (option) { var item = document.createElement('option'); item.value = option.value; item.textContent = option.label; item.selected = values.indexOf(option.value) >= 0; select.appendChild(item); });
    return select;
  }

  /**
   * 读取控件值并按展示类型转换为 JSON 值。
   * @param control - 页面输入控件
   * @returns 结构化字段值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-23
   */
  function readCollectionControl(control) {
    var type = control.dataset.collectionControl;
    if (type === 'boolean') return control.checked;
    if (type === 'number') return Number(control.value);
    if (type === 'multi-select') return Array.from(control.selectedOptions).map(function (option) { return option.value; });
    if (type === 'object') return JSON.parse(control.value);
    return control.value;
  }

  /**
   * 提交结构化收集值，仍由服务端重新抽取、校验并决定是否执行。
   * @param form - 参数表单节点
   * @param collection - 当前参数收集状态
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-23
   */
  function submitCollection(form, collection) {
    var values = Object.assign({}, collection.collected || {});
    try { Array.from(form.querySelectorAll('[data-collection-control]')).forEach(function (control) { if (control.value !== '' || control.dataset.collectionControl === 'boolean' || control.dataset.collectionControl === 'multi-select') values[control.name] = readCollectionControl(control); }); }
    catch (error) { showCollectionError('参数格式不正确，请按字段提示修改。'); return; }
    appendMsg('user', '补充参数'); recordConversation('user', '补充参数'); setBusy(true);
    streamChat('补充参数', values).catch(function () { if (!sessionExpired) showCollectionError('参数提交未完成，结果可能未知，请检查状态后重试。'); }).then(refreshState).finally(function () { setBusy(false); });
  }

  /**
   * 展示参数收集提交错误，不写入模型内容或原始异常。
   * @param message - 固定的用户可见错误消息
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-23
   */
  function showCollectionError(message) {
    var status = document.getElementById('copyContextStatus'); status.textContent = message;
  }

  document.getElementById('copyContextBtn').onclick = copyStructuredContext;

  /** 只显示最近八条事件，事件内容以纯文本呈现。
   * 页面列表上限仅影响展示，完整事件仍由会话资源上限约束。
   * 事件名和标识都使用 textContent，避免意外解释为标签。
   * 保留事件原有顺序，用户可以将最近事件与路由状态对照。
   * @param events - 会话事件列表
   * @returns 无返回值
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  function renderEvents(events) {
    var list = document.getElementById('eventList');
    list.innerHTML = '';
    events.slice(-8).forEach(function (event) {
      var li = document.createElement('li');
      var name = document.createElement('span');
      name.textContent = event.eventName;
      var time = document.createElement('span');
      time.className = 't';
      time.textContent = event.eventId;
      li.appendChild(name); li.appendChild(time); list.appendChild(li);
    });
  }

  // 固定能力清单只用于帮助用户理解离线演示的可用功能。
  // 文本和标识由 renderSubsystems 以纯文本写入页面。
  let SUBSYSTEMS = [
    ['knowledge.query', '平台通用知识'],
    ['dip.manage', '数据集成管理'],
    ['job.monitor', '任务调度监控'],
    ['api.gateway', 'API 网关管理'],
    ['dataset.query', '数据资产目录'],
    ['report.center', '报表中心'],
    ['system.status', '系统状态与告警'],
    ['account.privilege', '账户与权限'],
    ['ticket.create', '工单支持'],
    ['human.transfer', '人工服务']
  ];

  /** 在侧栏展示预定义功能及其稳定标识。
   * 清空旧列表后重建，重复调用不会产生重复条目。
   * 功能名称和标识均作为文本，不解释为 HTML。
   * 这份清单是静态说明，不参与服务端插件授权或路由。
   * 样式沿用页面模板中的布局，保证启动拼装后的显示一致。
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  function renderSubsystems() {
    var list = document.getElementById('subsystemList');
    list.innerHTML = '';
    SUBSYSTEMS.forEach(function (item) {
      var li = document.createElement('li');
      li.style.cssText = 'display:flex;justify-content:space-between;gap:8px;padding:4px 8px;background:#f8fafc;border:1px solid var(--border);border-radius:6px';
      var name = document.createElement('span');
      name.textContent = item[1];
      var id = document.createElement('span');
      id.style.cssText = 'font-family:var(--mono);color:var(--muted);font-size:11px';
      id.textContent = item[0];
      li.appendChild(name);
      li.appendChild(id);
      list.appendChild(li);
    });
  }

  // 先呈现静态欢迎内容，但在独立会话初始化完成前禁止所有操作。
  // 持久化或锁不可用时显示明确错误，不使用兼容共享入口兜底。
  // 刷新定时器仅调用只读状态入口，失效后由 refreshState 短路。
  // 初始化失败时不启用按钮，用户刷新页面可重新尝试建立会话。
  // 首次状态同步成功后才解除忙碌，包含已存在待确认动作的恢复。
  appendMsg('bot', '你好，我是 IAR Agent Sandbox。当前模拟的企业数据平台包含 10 个子系统：平台通用知识、数据集成管理（DIP）、任务调度监控、API 网关管理、数据资产目录、报表中心、系统状态与告警、账户与权限、工单支持与人工服务。输入一句话即可体验「意图 → Function → Plugin → 执行」全链路，右侧调试面板可查看路由证据、事件流和 BehaviorContext。');
  renderSubsystems();
  setBusy(true);
  Promise.resolve().then(initializeSession).then(function () {
    sessionReady = true;
    return refreshState();
  }).then(function () {
    refreshSessionList();
    setBusy(false);
  }).catch(function () {
    sessionReady = false;
    setBusy(false);
    if (!sessionExpired) appendMsg('bot', '无法建立独立会话，请检查浏览器存储、Web Locks 支持和服务连接后刷新页面。', '失败');
  });
  setInterval(refreshState, 3000);
}
