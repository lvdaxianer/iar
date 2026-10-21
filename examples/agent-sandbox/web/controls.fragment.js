  let lastReplySource = null;

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
      document.getElementById('routeReplySource').textContent = '-';
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
    document.getElementById('routeReplySource').textContent = '-';
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
    renderEvents(state.events);
  }

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
