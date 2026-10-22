
  // Pi 宿主演示页协议适配：与 8787 沙箱页共用样式与安全 Markdown 渲染，仅事件协议不同。
  // 每轮输入先经 IAR 前置路由（entry/route/confirm 事件），未命中由 Pi Agent 流式回答（piDelta/piDone）。
  // 会话标识仅保存在本标签页存储；历史回放与沙箱页一样使用本地存储，服务端不保存聊天正文。
  const PI_HOST_SESSION_KEY = 'iar.piHostSession';
  const PI_HOST_HISTORY_PREFIX = 'iar-pi-host-history-v1:';
  const PI_HOST_HISTORY_LIMIT = 100;
  const PI_HOST_EVENT_LIMIT = 8;
  const PI_HOST_SESSION_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
  const PI_HOST_DISPOSITION_META = { handled: '已执行', awaiting_confirmation: '等待确认', clarification: '需要澄清', context_answered: '已根据上下文回答', cancelled: '已取消', pass_through: '已通过' };
  const PI_HOST_REPLY_SOURCE_META = { direct_function: 'Function 直出', response_model: 'Response Model', pi_agent: 'Pi Agent', none: '无回复' };
  const PI_HOST_WELCOME = '你好，这里是 Pi × IAR 前置意图路由演示。本页与 8787 IAR Agent Sandbox 共用同一套界面与渲染资源，仅底层协议不同：每轮输入先经 Pi input hook 交给 IAR 意图识别与 Plugin/Function 动态路由，命中即展示 IAR 结果并阻断 Pi Agent；未命中才由进程内 Pi Agent 流式回答。右侧可查看调用链、路由证据与会话信息。';
  let piHostMessagesEl = document.getElementById('messages');
  let piHostInputEl = document.getElementById('messageInput');
  let piHostSendBtn = document.getElementById('sendBtn');
  let piHostSessionId = readPiHostSessionId();
  let piHostBusy = false;
  let piHostBubble = null;
  let piHostPendingRoute = null;
  let piHostPendingTiming = null;
  let piHostPendingConfirm = null;
  let piHostSessionInfo = null;
  let piHostExpectingEntry = false;
  let piHostEventSource = null;
  let piHostEvents = [];
  let piHostTurnStartedAt = 0;

  /** 读取本标签页的 Pi 会话标识；缺失、损坏或不合法时创建新标识。
   * 标识只进入请求参数与会话面板，不写入前端日志。
   * @returns 校验通过的会话标识
   * @author lvdaxianer@yeah.net
   * @date 2026-10-21
   */
  function readPiHostSessionId() {
    try {
      var stored = sessionStorage.getItem(PI_HOST_SESSION_KEY);
      if (PI_HOST_SESSION_PATTERN.test(stored || '')) return stored;
    } catch (err) { /* 存储不可用时按新会话处理。 */ }
    var created = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'pi-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    try { sessionStorage.setItem(PI_HOST_SESSION_KEY, created); } catch (err) { /* 失败时仅影响刷新恢复。 */ }
    return created;
  }

  /** 追加一条聊天消息，用户输入始终作为纯文本呈现。
   * 助手内容通过共用的受限 Markdown 渲染器转义，与沙箱页同一安全出口。
   * @param role - 用户或助手角色
   * @param text - 消息正文
   * @param meta - 可选状态文字
   * @param traceId - 可选完整 traceId，用于悬停提示
   * @returns 新建的消息容器
   * @author lvdaxianer@yeah.net
   * @date 2026-10-21
   */
  function appendMsg(role, text, meta, traceId) {
    var div = document.createElement('div');
    div.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
    if (role === 'user') {
      div.textContent = text;
    } else {
      var body = document.createElement('div');
      body.className = 'md-body';
      body.innerHTML = renderMarkdown(text);
      div.appendChild(body);
    }
    if (meta) appendMessageMeta(div, meta, traceId);
    piHostMessagesEl.appendChild(div);
    piHostMessagesEl.scrollTop = piHostMessagesEl.scrollHeight;
    return div;
  }

  /**
   * 在消息尾部显示动作或回复状态。
   * @param div - 消息容器
   * @param text - 用户可见状态
   * @param traceId - 可选完整 traceId
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-22
   */
  function appendMessageMeta(div, text, traceId) {
    var span = document.createElement('span');
    span.className = 'meta';
    span.textContent = text;
    if (traceId) span.title = '完整 traceId: ' + traceId;
    div.appendChild(span);
  }

  /** 读取本地历史；损坏记录按空处理，脏数据不进入渲染路径。
   * @returns 消息数组
   * @author lvdaxianer@yeah.net
   * @date 2026-10-21
   */
  function readPiHostHistory() {
    try {
      var record = JSON.parse(localStorage.getItem(PI_HOST_HISTORY_PREFIX + piHostSessionId) || '[]');
      return Array.isArray(record) ? record.filter(function (m) { return m && (m.role === 'user' || m.role === 'bot') && typeof m.text === 'string'; }) : [];
    } catch (err) { return []; }
  }

  /** 写入本地历史，超长丢弃最旧消息；存储不可用时降级为仅当前页面可见。 */
  function recordPiHostConversation(role, text, meta) {
    if (typeof text !== 'string') return;
    var messages = readPiHostHistory();
    messages.push({ role: role, text: text, at: Date.now(), ...(meta === undefined ? {} : { meta: meta }) });
    if (messages.length > PI_HOST_HISTORY_LIMIT) messages.splice(0, messages.length - PI_HOST_HISTORY_LIMIT);
    try { localStorage.setItem(PI_HOST_HISTORY_PREFIX + piHostSessionId, JSON.stringify(messages)); } catch (err) { /* 降级为内存展示。 */ }
  }

  /** 初始化时回放本地历史，重放与实时消息共用同一安全渲染出口。 */
  function renderPiHostHistory() {
    readPiHostHistory().forEach(function (message) { appendMsg(message.role, message.text, message.meta); });
  }

  /** 同步输入与发送按钮的忙碌状态；确认按钮各自检查 busy。
   * @param value - 当前是否有操作未结束
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-21
   */
  function setPiHostBusy(value) {
    piHostBusy = value;
    piHostSendBtn.disabled = value;
    piHostInputEl.disabled = value;
    document.getElementById('clearSessionBtn').disabled = value;
    document.querySelectorAll('.confirm-box button').forEach(function (button) { button.disabled = value; });
  }

  /** 记录并展示最近事件，事件名与详情都以纯文本呈现。
   * @param name - 事件名
   * @param detail - 事件详情
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-21
   */
  function recordPiHostEvent(name, detail) {
    piHostEvents.push({ name: name, detail: detail });
    if (piHostEvents.length > PI_HOST_EVENT_LIMIT) piHostEvents.shift();
    var list = document.getElementById('eventList');
    list.innerHTML = '';
    piHostEvents.forEach(function (event) {
      var li = document.createElement('li');
      var nameEl = document.createElement('span');
      nameEl.textContent = event.name;
      var detailEl = document.createElement('span');
      detailEl.className = 't';
      detailEl.textContent = event.detail;
      li.appendChild(nameEl);
      li.appendChild(detailEl);
      list.appendChild(li);
    });
  }

  /** 高亮调用链节点，其余节点恢复默认；空数组清除全部高亮。
   * @param nodes - 要激活的节点名列表
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-21
   */
  function highlightPiHostFlow(nodes) {
    document.querySelectorAll('#flowList li').forEach(function (li) {
      li.className = nodes.indexOf(li.getAttribute('data-node')) >= 0 ? 'active' : '';
    });
  }

  /** 用路由证据更新右侧调试面板，缺失字段使用占位符。
   * @param route - 本轮 bridge 路由摘要
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-21
   */
  function updatePiHostRoutePanel(route) {
    document.getElementById('routeFunction').textContent = route.functionId || '-';
    document.getElementById('routePlugin').textContent = route.pluginId || '-';
    document.getElementById('routeOperation').textContent = route.operationKind || '-';
    document.getElementById('routeStatus').textContent = route.disposition || '-';
    document.getElementById('routeReplySource').textContent = PI_HOST_REPLY_SOURCE_META[route.replySource] || route.replySource || '-';
    document.getElementById('routeConfidence').textContent = route.semanticIntent ? route.semanticIntent + '（' + Math.round((route.semanticConfidence || 0) * 100) + '%）' : '-';
    document.getElementById('routeScore').textContent = route.reasonCode || '-';
    document.getElementById('routeExpected').textContent = route.expectedOperation || '-';
    document.getElementById('routeActual').textContent = route.actualOperation || '-';
  }

  /**
   * 展示服务端阶段耗时，原始 thinking 不进入日志或计时面板。
   */
  function updatePiHostTimingPanel(timing) {
    if (!timing || typeof timing !== 'object') return;
    document.getElementById('timingTotal').textContent = typeof timing.durationMs === 'number' ? timing.durationMs + 'ms' : '-';
    renderTimingTrace(timing);
    var list = document.getElementById('timingList');
    list.innerHTML = '';
    (Array.isArray(timing.stages) ? timing.stages : []).forEach(function (stage) {
      var item = document.createElement('li');
      item.textContent = (stage.stage || '-') + ' · ' + (stage.durationMs || 0) + 'ms' + (stage.firstTokenMs === undefined ? '' : ' · 首 token / first token ' + stage.firstTokenMs + 'ms');
      list.appendChild(item);
    });
  }

  /**
   * 记录浏览器可见的端到端耗时，帮助区分服务端耗时与网络/渲染耗时。
   */
  function updatePiHostClientTiming() {
    if (piHostTurnStartedAt > 0) document.getElementById('timingClientTotal').textContent = (Date.now() - piHostTurnStartedAt) + 'ms';
  }

  /** 更新结构化上下文复制状态；状态使用 aria-live 对键盘和辅助技术可见。
   * @param message - 要展示给用户的状态文字
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-22
   */
  function setPiHostContextCopyStatus(message) {
    document.getElementById('contextCopyStatus').textContent = message;
  }

  /** 生成当前页面可复制的脱敏结构化上下文文本。
   * @returns 格式化后的结构化 JSON
   * @author lvdaxianer@yeah.net
   * @date 2026-10-22
   */
  function buildPiHostContextText() {
    return JSON.stringify(buildPiHostContextSnapshot({ session: { sessionId: piHostSessionId, mode: piHostSessionInfo && piHostSessionInfo.mode, bridgeUrl: piHostSessionInfo && piHostSessionInfo.bridgeUrl }, route: piHostPendingRoute, timing: piHostPendingTiming, pending: piHostPendingConfirm, events: piHostEvents }), null, 2);
  }

  /** 使用隐藏文本框兼容不支持 Clipboard API 的本地浏览器。
   * @param text - 要复制的文本
   * @returns 是否复制成功
   * @author lvdaxianer@yeah.net
   * @date 2026-10-22
   */
  function copyPiHostContextFallback(text) {
    var textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    var copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  }

  /** 复制版本化脱敏快照，并在页面上反馈成功或失败。
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-22
   */
  function copyPiHostContext() {
    var text = buildPiHostContextText();
    var copyPromise = navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(text) : Promise.resolve(copyPiHostContextFallback(text));
    copyPromise.then(function (copied) {
      if (copied === false) throw new Error('copy_failed');
      setPiHostContextCopyStatus('已复制结构化上下文');
    }).catch(function () { setPiHostContextCopyStatus('复制失败，请检查浏览器剪贴板权限'); });
  }

  /** 创建 Pi Agent 流式气泡，带 Thinking 指示器（三点动画）；
   * 增量期间纯文本追加，只有终态才转换为安全 Markdown。
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-21
   */
  function createPiHostBubble() {
    var div = document.createElement('div');
    div.className = 'msg bot';
    var textEl = document.createElement('div');
    textEl.className = 'md-body';
    var stageEl = document.createElement('span');
    stageEl.className = 'thinking';
    var dots = document.createElement('span');
    dots.className = 'thinking-dots';
    for (var index = 0; index < 3; index += 1) dots.appendChild(document.createElement('i'));
    var label = document.createElement('span');
    label.className = 'thinking-label';
    label.textContent = 'Thinking';
    stageEl.appendChild(dots);
    stageEl.appendChild(label);
    div.appendChild(textEl);
    div.appendChild(stageEl);
    piHostMessagesEl.appendChild(div);
    piHostMessagesEl.scrollTop = piHostMessagesEl.scrollHeight;
    piHostBubble = { div: div, textEl: textEl, stageEl: stageEl, gotDelta: false };
  }

  /** 追加 Pi Agent 增量，首个增量到达时移除 Thinking 指示器。 */
  function appendPiHostDelta(text) {
    if (!piHostBubble) createPiHostBubble();
    if (!piHostBubble.gotDelta) { piHostBubble.gotDelta = true; piHostBubble.stageEl.remove(); }
    piHostBubble.textEl.textContent += text;
    piHostMessagesEl.scrollTop = piHostMessagesEl.scrollHeight;
  }

  /** 结束 Pi Agent 气泡：终态后统一做 Markdown 渲染并记录历史。
   * 原始文本必须在替换 innerHTML 前快照，渲染后的 textContent 会丢失换行与标记。
   * @param reply - 服务端回传的完整回复
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-21
   */
  function finalizePiHostBubble(reply, timing) {
    var meta = formatTimingMeta('Pi 兜底', timing);
    if (!piHostBubble) { if (reply) { appendMsg('bot', reply, meta.text, meta.traceId); recordPiHostConversation('bot', reply, meta.text); } return; }
    var bubble = piHostBubble;
    piHostBubble = null;
    bubble.stageEl.remove();
    if (!bubble.gotDelta && !reply) { bubble.div.remove(); return; }
    if (!bubble.gotDelta) bubble.textEl.textContent = reply;
    var rawText = bubble.textEl.textContent;
    bubble.textEl.innerHTML = renderMarkdown(rawText);
    appendMessageMeta(bubble.div, meta.text, meta.traceId);
    recordPiHostConversation('bot', rawText, meta.text);
    piHostMessagesEl.scrollTop = piHostMessagesEl.scrollHeight;
  }

  /** 由 entry disposition 与本轮路由生成状态标签，handled 附 Function 标识。 */
  function piHostEntryMeta(data) {
    var meta = PI_HOST_DISPOSITION_META[data.disposition] || data.disposition || '已执行';
    if (data.disposition === 'handled' && piHostPendingRoute && piHostPendingRoute.functionId) meta += ' · ' + piHostPendingRoute.functionId;
    if (PI_HOST_REPLY_SOURCE_META[data.replySource]) meta += ' · ' + PI_HOST_REPLY_SOURCE_META[data.replySource];
    return meta;
  }

  /** 把 IAR 结果以打字机方式写入本轮气泡，与 Pi 增量同一渐进呈现。
   * 历史记录的是完整原文，不受分片影响；期间用户可继续发起新轮次。
   * @param text - entry 完整正文
   * @param meta - 终态状态标签
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-21
   */
  function streamPiHostEntryText(text, meta) {
    var bubble = piHostBubble;
    bubble.gotDelta = true;
    bubble.stageEl.remove();
    var cursor = 0;
    var timer = setInterval(function () {
      cursor = Math.min(text.length, cursor + 12);
      bubble.textEl.textContent = text.slice(0, cursor);
      piHostMessagesEl.scrollTop = piHostMessagesEl.scrollHeight;
      if (cursor < text.length) return;
      clearInterval(timer);
      bubble.entryTimer = null;
      finalizePiHostEntryText(bubble, text, meta);
    }, 16);
    bubble.entryTimer = timer;
  }

  /** IAR 结果流式收尾：终态统一 Markdown 渲染、加状态标签并记录历史。
   * 只有气泡仍属于本轮时才解除引用，避免清掉新轮次的气泡。 */
  function finalizePiHostEntryText(bubble, rawText, meta) {
    if (piHostBubble === bubble) piHostBubble = null;
    bubble.textEl.innerHTML = renderMarkdown(rawText);
    appendMessageMeta(bubble.div, meta.text, meta.traceId);
    recordPiHostConversation('bot', rawText, meta.text);
    piHostMessagesEl.scrollTop = piHostMessagesEl.scrollHeight;
  }

  /** 校验并渲染 IAR entry，异常信封直接忽略，避免空卡片污染会话。
   * 仅接受 iar-bridge 自定义类型，content 以纯文本展示。
   * 本轮气泡仍在时把结果流式写入气泡，否则直接渲染（确认结果等滞后事件）。
   * @param entry - SSE entry 事件负载
   * @returns 是否完成渲染
   * @author lvdaxianer@yeah.net
   * @date 2026-10-21
   */
  function renderPiHostEntry(entry) {
    var data = (entry && typeof entry === 'object' && 'data' in entry && entry.data && typeof entry.data === 'object') ? entry.data : null;
    if (!data || entry.customType !== 'iar-bridge' || typeof data.content !== 'string') return false;
    var meta = formatTimingMeta(piHostEntryMeta(data), piHostPendingTiming);
    piHostPendingTiming = null;
    if (piHostBubble && piHostExpectingEntry) streamPiHostEntryText(data.content, meta);
    else { appendMsg('bot', data.content, meta.text, meta.traceId); recordPiHostConversation('bot', data.content, meta.text); }
    if (data.disposition === 'handled' || data.disposition === 'context_answered') highlightPiHostFlow(['input', 'hook', 'iar', 'handled']);
    return true;
  }

  /** 移除全部确认卡片；新确认事件或清空事件都走这里。 */
  function clearPiHostConfirmBoxes() {
    document.querySelectorAll('.confirm-box').forEach(function (box) { box.remove(); });
  }

  /** 移除当前气泡（IAR 命中或请求失败时），避免残留空的 Thinking 指示器。 */
  function removePiHostBubble() {
    if (!piHostBubble) return;
    piHostBubble.div.remove();
    piHostBubble = null;
  }

  /** 展示待确认动作卡片，确认/取消回到 IAR 权威会话。
   * 卡片样式与沙箱页一致；点击后移除卡片并等待 SSE entry 渲染结果。
   * @param pending - bridge 待确认动作
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-21
   */
  function showPiHostConfirmBox(pending) {
    clearPiHostConfirmBoxes();
    var box = document.createElement('div');
    box.className = 'confirm-box';
    var title = document.createElement('div');
    title.textContent = '待确认动作：' + pending.functionId + ' / ' + pending.pluginId + '（风险等级 ' + pending.riskLevel + '）';
    var detail = document.createElement('div');
    detail.style.cssText = 'margin-top:6px;font-family:var(--mono);font-size:11px;color:var(--muted)';
    detail.textContent = JSON.stringify({ actionId: pending.actionId, runId: pending.runId });
    var actions = document.createElement('div');
    actions.className = 'actions';
    actions.appendChild(piHostConfirmButton('确认执行', 'ok', true));
    actions.appendChild(piHostConfirmButton('取消', 'danger', false));
    box.appendChild(title);
    box.appendChild(detail);
    box.appendChild(actions);
    piHostMessagesEl.appendChild(box);
    piHostMessagesEl.scrollTop = piHostMessagesEl.scrollHeight;
  }

  /** 构造确认按钮；禁用与忙碌检查在点击时再次生效，防止外部脚本跳过校验。 */
  function piHostConfirmButton(label, style, accepted) {
    var button = document.createElement('button');
    button.className = style;
    button.textContent = label;
    button.disabled = piHostBusy;
    button.onclick = function () {
      if (piHostBusy) return;
      clearPiHostConfirmBoxes();
      setPiHostBusy(true);
      piHostPost('/api/pi-host/confirm', { session: piHostSessionId, accepted: accepted })
        .catch(function () { appendMsg('bot', '确认请求失败，请检查状态后重试。', '失败'); })
        .finally(function () { setPiHostBusy(false); });
    };
    return button;
  }

  /** 发送 Pi host JSON 请求；非成功响应抛出由调用方统一提示。
   * @param path - 请求路径
   * @param body - 请求体
   * @returns 解析后的响应对象 Promise
   * @author lvdaxianer@yeah.net
   * @date 2026-10-21
   */
  function piHostPost(path, body) {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (res) { if (!res.ok) throw new Error('request_failed'); return res.json(); });
  }

  /** 提交一轮用户输入；handled 由 entry 事件渲染，continue 由 piDone 收尾。
   * 网络失败恢复输入文本，不自动重试可能已经执行的输入。
   * @param text - 用户提交的消息
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-21
   */
  function submitPiHostTurn(text) {
    setPiHostBusy(true);
    piHostTurnStartedAt = Date.now();
    appendMsg('user', text);
    recordPiHostConversation('user', text);
    highlightPiHostFlow(['input']);
    createPiHostBubble();
    piHostExpectingEntry = true;
    piHostPost('/api/pi-host/chat', { session: piHostSessionId, text: text })
      .then(function (result) {
        piHostExpectingEntry = false;
        if (result && result.action === 'handled') setPiHostBusy(false);
      })
      .catch(function () {
        piHostExpectingEntry = false;
        removePiHostBubble();
        piHostInputEl.value = text;
        appendMsg('bot', '请求未完成，结果可能未知；请检查状态后再重试。', '失败');
        setPiHostBusy(false);
      });
  }

  /** 绑定 SSE 事件源；断线只更新连接徽标，页面状态等待下一次事件。
   * 所有事件负载先校验再使用，异常事件不中断后续处理。
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-21
   */
  function connectPiHostEvents() {
    var es = new EventSource('/api/pi-host/events?session=' + encodeURIComponent(piHostSessionId));
    piHostEventSource = es;
    var connBadge = document.getElementById('connBadge');
    es.addEventListener('ready', function (event) {
      var info = JSON.parse(event.data);
      piHostSessionInfo = { mode: info.mode, bridgeUrl: info.bridgeUrl };
      var brain = info.mode === 'brain';
      var modeBadge = document.getElementById('modeBadge');
      modeBadge.textContent = brain ? 'brain real · 真实 LLM' : 'brain scripted · 离线假大脑';
      modeBadge.className = 'badge' + (brain ? '' : ' scripted');
      document.getElementById('bridgeBadge').textContent = 'bridge ' + info.bridgeUrl;
      connBadge.textContent = '已连接';
      connBadge.className = 'badge';
      document.getElementById('sessionJson').textContent = JSON.stringify({ sessionId: piHostSessionId, mode: info.mode, bridgeUrl: info.bridgeUrl }, null, 2);
    });
    es.onerror = function () { connBadge.textContent = '断开'; connBadge.className = 'badge scripted'; };
    es.addEventListener('route', function (event) {
      piHostPendingRoute = JSON.parse(event.data);
      updatePiHostRoutePanel(piHostPendingRoute);
      highlightPiHostFlow(['input', 'hook', 'iar']);
      recordPiHostEvent('路由', piHostPendingRoute.disposition || '-');
    });
    es.addEventListener('timing', function (event) {
      var timing;
      try { timing = JSON.parse(event.data); } catch (err) { return; }
      piHostPendingTiming = timing;
      updatePiHostTimingPanel(timing);
      recordPiHostEvent('耗时', (timing.durationMs || 0) + 'ms');
    });
    es.addEventListener('entry', function (event) {
      var entry;
      try { entry = JSON.parse(event.data); } catch (err) { return; }
      if (renderPiHostEntry(entry)) recordPiHostEvent('IAR', (entry.data && entry.data.disposition) || '-');
    });
    es.addEventListener('confirm', function (event) {
      var pending = JSON.parse(event.data);
      piHostPendingConfirm = pending;
      if (pending) { showPiHostConfirmBox(pending); recordPiHostEvent('确认', '等待 ' + pending.actionId); }
      else { clearPiHostConfirmBoxes(); recordPiHostEvent('确认', '已清空'); }
    });
    es.addEventListener('notify', function (event) {
      var notification = JSON.parse(event.data);
      if (piHostBubble && !piHostBubble.gotDelta) removePiHostBubble();
      appendMsg('bot', notification.message, notification.type === 'error' ? '错误' : '提示');
      recordPiHostEvent('通知', notification.message.slice(0, 24));
    });
    es.addEventListener('piDelta', function (event) { appendPiHostDelta(JSON.parse(event.data)); });
    es.addEventListener('piDone', function (event) {
      finalizePiHostBubble(JSON.parse(event.data), piHostPendingTiming);
      piHostPendingTiming = null;
      updatePiHostClientTiming();
      highlightPiHostFlow(['input', 'hook', 'iar', 'continue']);
      setPiHostBusy(false);
      recordPiHostEvent('Pi', '回答完成');
    });
  }

  /** 重置右侧调试面板与事件列表到初始状态，供清空会话后复用。
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-21
   */
  function resetPiHostDebugPanel() {
    piHostPendingRoute = null;
    piHostPendingTiming = null;
    piHostPendingConfirm = null;
    piHostSessionInfo = null;
    piHostEvents = [];
    document.getElementById('eventList').innerHTML = '';
    document.getElementById('sessionJson').textContent = '{}';
    updatePiHostRoutePanel({});
    document.getElementById('timingTotal').textContent = '-';
    document.getElementById('timingTraceId').textContent = '-';
    document.getElementById('timingClientTotal').textContent = '-';
    document.getElementById('timingList').innerHTML = '';
    setPiHostContextCopyStatus('');
    highlightPiHostFlow([]);
  }

  /** 清空会话：删除本页历史、换新会话标识并重连事件源。
   * bridge 没有 reset 端点，旧服务端会话随旧连接关闭由服务端释放。
   * 忙碌期间禁止清空，避免切断进行中的轮次；流式计时器一并停止。
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-21
   */
  function clearPiHostSession() {
    if (piHostBusy) return;
    if (!confirm('清空会话将删除本页聊天记录并建立全新会话，确定继续吗？')) return;
    if (piHostBubble && piHostBubble.entryTimer) clearInterval(piHostBubble.entryTimer);
    try {
      localStorage.removeItem(PI_HOST_HISTORY_PREFIX + piHostSessionId);
      sessionStorage.removeItem(PI_HOST_SESSION_KEY);
    } catch (err) { /* 尽力清理，失败时新会话仍会建立。 */ }
    if (piHostEventSource) piHostEventSource.close();
    piHostSessionId = readPiHostSessionId();
    piHostExpectingEntry = false;
    removePiHostBubble();
    clearPiHostConfirmBoxes();
    resetPiHostDebugPanel();
    piHostMessagesEl.innerHTML = '';
    appendMsg('bot', PI_HOST_WELCOME);
    connectPiHostEvents();
    recordPiHostEvent('会话', '已清空');
  }

  // 表单提交由脚本拦截；欢迎消息只在无本地历史时展示一次。
  // 与沙箱页一致，服务端终态以 SSE 事件为准，页面忙碌状态随事件收尾。
  document.getElementById('inputBar').onsubmit = function (event) {
    event.preventDefault();
    if (piHostBusy) return;
    var text = piHostInputEl.value.trim();
    if (!text) return;
    piHostInputEl.value = '';
    submitPiHostTurn(text);
  };
  document.getElementById('clearSessionBtn').onclick = clearPiHostSession;
  document.getElementById('copyContextBtn').onclick = copyPiHostContext;
  if (readPiHostHistory().length === 0) {
    appendMsg('bot', PI_HOST_WELCOME);
  } else {
    renderPiHostHistory();
  }
  connectPiHostEvents();
