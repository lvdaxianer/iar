
  // 会话列表数据来自 GET /api/sessions 摘要接口；聊天记录按会话标识保存在本地持久存储。
  // 切换顺序为先占锁、再恢复、成功后替换身份；模块状态只缓存游标与请求序号。
  const HISTORY_STORAGE_PREFIX = 'iar-sandbox-history-v1:';
  const HISTORY_MESSAGE_LIMIT = 100;
  const HISTORY_SESSION_LIMIT = 30;
  const SESSION_LIST_PAGE_SIZE = 20;
  const SESSION_SUMMARY_CHARS = 24;
  let sessionsNextCursor = null;
  let sessionsRequestId = 0;

  /** 读取一条本地历史记录；缺失或损坏时返回空由调用方兜底。
   * @param id - 会话标识
   * @returns 解析后的记录对象，或 null
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function readConversationRecord(id) {
    try {
      var record = JSON.parse(localStorage.getItem(HISTORY_STORAGE_PREFIX + id) || 'null');
      return record && typeof record === 'object' ? record : null;
    } catch (err) { return null; }
  }

  /** 校验历史消息结构，只保留角色与正文合法的条目。
   * 本地存储可被用户改写，回放前必须重新校验，避免脏数据进入渲染路径。
   * @param message - 待校验的单条历史
   * @returns 是否可安全回放
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function isConversationMessage(message) {
    return Boolean(message) && (message.role === 'user' || message.role === 'bot') && typeof message.text === 'string';
  }

  /** 读取指定会话的本地历史，供切换时回放。
   * @param id - 会话标识
   * @returns 校验后的消息数组
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function readConversation(id) {
    var record = readConversationRecord(id);
    if (!record || !Array.isArray(record.messages)) return [];
    return record.messages.filter(isConversationMessage);
  }

  /** 按键直接删除本地历史，供清理与淘汰路径复用。
   * @param key - 完整存储键
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function clearConversationKey(key) {
    try { localStorage.removeItem(key); } catch (err) { /* 清理失败时保留现有数据。 */ }
  }

  /** 清理指定会话的本地历史；重置与过期路径使用。
   * @param id - 会话标识
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function clearConversation(id) {
    if (!id) return;
    clearConversationKey(HISTORY_STORAGE_PREFIX + id);
  }

  /** 写入一条会话历史；条数与会话数都有上限，超界丢弃最旧数据。
   * @param id - 会话标识
   * @param messages - 完整消息数组
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function writeConversation(id, messages) {
    try {
      localStorage.setItem(HISTORY_STORAGE_PREFIX + id, JSON.stringify({ updatedAt: Date.now(), messages: messages }));
      evictOldConversations();
    } catch (err) { /* 存储不可用时历史降级为仅当前页面可见。 */ }
  }

  /** 会话数超界时按更新时间淘汰最旧的记录。
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function evictOldConversations() {
    var entries = [];
    for (var index = 0; index < localStorage.length; index += 1) {
      var key = localStorage.key(index);
      // 非历史键不进入淘汰统计；损坏记录按最旧时间处理。
      if (key.indexOf(HISTORY_STORAGE_PREFIX) !== 0) continue;
      var record = readConversationRecord(key.slice(HISTORY_STORAGE_PREFIX.length));
      entries.push({ key: key, updatedAt: record && typeof record.updatedAt === 'number' ? record.updatedAt : 0 });
    }
    entries.sort(function (a, b) { return a.updatedAt - b.updatedAt; });
    while (entries.length > HISTORY_SESSION_LIMIT) clearConversationKey(entries.shift().key);
  }

  /** 记录一条会话消息；未就绪或文本非法时静默跳过。
   * @param role - 用户或助手角色
   * @param text - 消息正文
   * @param meta - 可选状态文字
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function recordConversation(role, text, meta) {
    if (!sessionId || typeof text !== 'string') return;
    var messages = readConversation(sessionId);
    messages.push({ role: role, text: text, at: Date.now(), ...(meta === undefined ? {} : { meta: meta }) });
    if (messages.length > HISTORY_MESSAGE_LIMIT) messages.splice(0, messages.length - HISTORY_MESSAGE_LIMIT);
    writeConversation(sessionId, messages);
  }

  /** 切换会话时回放本地历史，重放与实时消息共用同一安全渲染出口。
   * @param id - 目标会话标识
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function renderConversation(id) {
    messagesEl.innerHTML = '';
    readConversation(id).forEach(function (message) { appendMsg(message.role, message.text, message.meta); });
  }

  /** 组装列表请求地址；有游标时携带游标继续分页。
   * @returns 带分页参数的列表地址
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function sessionListUrl() {
    var url = '/api/sessions?limit=' + SESSION_LIST_PAGE_SIZE;
    return sessionsNextCursor ? url + '&cursor=' + encodeURIComponent(sessionsNextCursor) : url;
  }

  /** 请求一页会话摘要；过期响应直接丢弃，避免慢请求覆盖新列表。
   * @param isAppend - 是否追加到当前列表
   * @returns 请求完成的 Promise
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function fetchSessionList(isAppend) {
    var requestId = ++sessionsRequestId;
    showSessionsStatus('加载中…');
    return fetch(sessionListUrl()).then(function (res) {
      if (!res.ok) throw new Error('session_list_failed');
      return res.json();
    }).then(function (page) {
      if (requestId !== sessionsRequestId) return;
      sessionsNextCursor = typeof page.nextCursor === 'string' ? page.nextCursor : null;
      renderSessionList(Array.isArray(page.sessions) ? page.sessions : [], isAppend);
    });
  }

  /** 刷新会话列表到第一页；失败时给出可重试的提示。
   * @returns 请求完成的 Promise
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function refreshSessionList() {
    sessionsNextCursor = null;
    return fetchSessionList(false).catch(function () { showSessionsStatus('会话列表加载失败，请点击刷新重试。'); });
  }

  /** 继续加载下一页并追加到列表尾部。
   * @returns 请求完成的 Promise
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function loadMoreSessions() {
    if (!sessionsNextCursor) return Promise.resolve();
    return fetchSessionList(true).catch(function () { showSessionsStatus('加载更多失败，请点击刷新重试。'); });
  }

  /** 更新列表状态行；空文本时状态行自动隐藏。
   * @param text - 用户可见状态文字
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function showSessionsStatus(text) {
    document.getElementById('sessionsStatus').textContent = text;
  }

  /** 渲染会话摘要列表；追加模式保留已有条目用于分页。
   * @param items - 服务端返回的摘要条目
   * @param isAppend - 是否追加渲染
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function renderSessionList(items, isAppend) {
    var listEl = document.getElementById('sessionsList');
    // 首页刷新时清空重建，避免旧条目与新数据混排。
    if (!isAppend) listEl.innerHTML = '';
    items.forEach(function (item) { if (isSessionSummary(item)) listEl.appendChild(createSessionItem(item)); });
    // 服务端摘要可能尚未包含当前会话；本地兜底插入并置顶，保证当前会话始终可见且可标识。
    if (!isAppend && typeof sessionId === 'string' && sessionId.length > 0
      && !items.some(function (item) { return isSessionSummary(item) && item.sessionId === sessionId; })) {
      var fallback = currentSessionFallbackSummary();
      listEl.insertBefore(createSessionItem({ sessionId: sessionId, summary: fallback }), listEl.firstChild || null);
    }
    document.getElementById('sessionsMoreBtn').hidden = !sessionsNextCursor;
    if (listEl.children.length === 0) showSessionsStatus('暂无会话，点击「新建会话」开始。');
    else showSessionsStatus('');
  }

  /** 当前会话不在服务端摘要时的兜底文字：取本地历史最后一条用户消息。
   * @returns 兜底摘要文本
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function currentSessionFallbackSummary() {
    var history = readConversation(sessionId);
    for (var index = history.length - 1; index >= 0; index -= 1) {
      if (history[index].role === 'user') return history[index].text;
    }
    return '（当前会话）';
  }

  /** 校验摘要条目结构；非法标识或类型不进入列表。
   * @param item - 服务端摘要条目
   * @returns 条目是否可展示
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function isSessionSummary(item) {
    return Boolean(item) && /^[A-Za-z0-9_-]{32}$/.test(item.sessionId) && (item.summary === undefined || typeof item.summary === 'string');
  }

  /** 构造单个会话条目按钮，点击后进入切换流程。
   * @param item - 服务端摘要条目
   * @returns 列表条目元素
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function createSessionItem(item) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    button.textContent = sessionItemLabel(item);
    button.onclick = function () { switchSession(item.sessionId); };
    var li = document.createElement('li');
    if (item.sessionId === sessionId) li.className = 'current';
    li.appendChild(button);
    return li;
  }

  /** 条目文字使用服务端摘要截断；当前会话追加文字标记而非仅靠样式。
   * @param item - 服务端摘要条目
   * @returns 条目展示文字
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function sessionItemLabel(item) {
    var trimmed = typeof item.summary === 'string' ? item.summary.trim() : '';
    var summary = trimmed ? trimmed.slice(0, SESSION_SUMMARY_CHARS) : '（无摘要）';
    return item.sessionId === sessionId ? summary + ' · 当前' : summary;
  }

  /** 判断当前是否允许发起切换；忙碌、失效或目标即当前会话时拒绝。
   * @param id - 目标会话标识
   * @returns 是否允许切换
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function canSwitchSession(id) {
    if (!sessionReady || sessionBusy || sessionExpired) return false;
    if (id === sessionId) return false;
    return /^[A-Za-z0-9_-]{32}$/.test(id);
  }

  /** 切换到指定会话；先占锁再恢复，成功后替换当前会话身份。
   * @param id - 目标会话标识
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function switchSession(id) {
    if (!canSwitchSession(id)) return;
    setBusy(true);
    var claimed = null;
    claimSession(id).then(function (lease) {
      // 锁被其他标签页持有时留在当前会话，不发起恢复请求。
      if (!lease) return failSwitch('目标会话正在其他标签页中使用，无法切换。', null, null);
      claimed = lease;
      return resumeTargetSession(id, lease);
    }).catch(function () { failSwitch('切换请求失败，请检查状态后重试。', claimed, null); });
  }

  /** 恢复目标会话；不可恢复时释放锁并刷新列表剔除失效条目。
   * @param id - 目标会话标识
   * @param lease - 已占有的目标会话锁
   * @returns 恢复完成的 Promise
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function resumeTargetSession(id, lease) {
    return fetch('/api/sessions/' + encodeURIComponent(id) + '/resume', { method: 'POST' }).then(function (res) {
      // 恢复响应不走统一过期检查，避免误伤当前会话。
      if (!res.ok) return failSwitch('目标会话已无法恢复，可能已过期。', lease, id);
      applySessionSwitch(id, lease);
    });
  }

  /** 切换失败处理：释放已占锁、提示用户并保持当前会话可用。
   * @param message - 用户可见失败原因
   * @param lease - 已占有的目标锁，可能为空
   * @param id - 目标会话标识，可能为空
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function failSwitch(message, lease, id) {
    // 已占锁必须归还，否则目标会话会被本标签页无限期独占。
    if (lease) lease.release();
    appendMsg('bot', message, '失败');
    // 目标可能已过期，刷新列表剔除失效条目。
    if (id) refreshSessionList();
    setBusy(false);
  }

  /** 应用切换结果：替换身份、释放旧锁、回放历史并同步状态。
   * @param id - 目标会话标识
   * @param lease - 已占有的目标会话锁
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function applySessionSwitch(id, lease) {
    var oldLease = sessionLease;
    sessionLease = lease;
    sessionId = id;
    pendingRunId = null;
    document.querySelectorAll('.confirm-box').forEach(function (box) { box.remove(); });
    try { sessionStorage.setItem(SESSION_KEY, id); sessionStorage.setItem(TAB_KEY, tabId); } catch (err) { /* 失败时刷新回退为新建路径。 */ }
    // 新锁就绪后才释放旧锁，切换窗口内始终有一个可恢复会话。
    if (oldLease) oldLease.release();
    renderConversation(id);
    refreshSessionList();
    setBusy(false);
    refreshState();
  }

  /** 展开或收起会话列表面板；展开时总是拉取最新列表。
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  function toggleSessionsPanel() {
    var panel = document.getElementById('sessionsPanel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) refreshSessionList();
  }

  // 面板初始化为收起态，兼容不解析 hidden 属性的宿主环境。
  document.getElementById('sessionsPanel').hidden = true;
  document.getElementById('sessionsBtn').onclick = function () {
    if (sessionExpired) return;
    toggleSessionsPanel();
  };
  document.getElementById('sessionsRefreshBtn').onclick = function () {
    if (!sessionBusy && !sessionExpired) refreshSessionList();
  };
  document.getElementById('sessionsMoreBtn').onclick = function () {
    if (!sessionBusy && !sessionExpired) loadMoreSessions();
  };
