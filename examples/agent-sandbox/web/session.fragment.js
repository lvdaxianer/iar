
'use strict';
{
  let messagesEl = document.getElementById('messages');
  let inputEl = document.getElementById('messageInput');
  let sendBtn = document.getElementById('sendBtn');
  let pendingRunId = null;
  let sessionId = null;
  let sessionReady = false;
  let sessionExpired = false;
  let sessionBusy = false;
  let SESSION_KEY = 'iar-sandbox-session-v1';
  let RELOAD_KEY = SESSION_KEY + '-reload';
  let TAB_KEY = SESSION_KEY + '-tab';
  let sessionLease = null;
  let tabId = null;

  /** 关闭过期会话入口，保留用户输入且绝不重试先前操作。
   * 服务重启和会话过期都由同一个 404 状态处理。
   * 清除本标签页持久标识，但不悄悄创建替代会话。
   * 去除旧确认控件，避免对已不存在的动作发出确认。
   * 多次收到过期响应时只提示一次。
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  function expireSession() {
    if (sessionExpired) return;
    sessionExpired = true;
    sessionReady = false;
    try { sessionStorage.removeItem(SESSION_KEY); } catch (err) { /* 仍然禁用失效会话。 */ }
    if (sessionLease) { sessionLease.release(); sessionLease = null; }
    document.querySelectorAll('.confirm-box').forEach(function (box) { box.remove(); });
    appendMsg('bot', '会话已过期或服务已重启。请刷新页面开始新会话；原操作不会自动重试。', '会话失效');
    setBusy(false);
  }

  /** 仅以服务端返回的固定状态识别过期，其他错误保留原会话。
   * 其他 HTTP 失败不能推断业务操作是否已经发生。
   * 调用方据此展示不确定结果而不是自动重试。
   * @param res - 当前请求的 HTTP 响应
   * @returns 成功时原样返回响应
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  function checkResponse(res) {
    if (res.status === 404) { expireSession(); throw new Error('session_expired'); }
    if (!res.ok) throw new Error('request_failed');
    return res;
  }

  /** 将所有会话操作绑定到当前标签页的独立标识。
   * 没有完成独占和初始化时，任何业务请求都不得发出。
   * 标识只进入 URL，不用于前端日志或提示。
   * @param path - 会话路由后缀
   * @param options - fetch 请求配置
   * @returns 已验证状态的响应 Promise
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  function sessionFetch(path, options) {
    if (!sessionReady || !sessionId) return Promise.reject(new Error('session_unavailable'));
    return fetch('/api/sessions/' + encodeURIComponent(sessionId) + path, options).then(checkResponse);
  }

  /** 原子占用会话，浏览器销毁页面时自动释放锁。
   * 复制标签页可能复制 sessionStorage，必须先申请锁才能复用。
   * 锁已经属于其他标签页时返回 false，调用方创建新会话。
   * 持有期间 Promise 保持未决，页面卸载由浏览器释放锁。
   * @param id - 待占用的服务端会话标识
   * @returns 是否成功获得独占权
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  function claimSession(id) {
    var releaseLock;
    var held = new Promise(function (resolve) { releaseLock = resolve; });
    return new Promise(function (resolve, reject) {
      navigator.locks.request('iar-sandbox-session:' + id, { ifAvailable: true }, function (lock) {
        if (!lock) { resolve(null); return; }
        var lease = { release: function () { releaseLock(); } };
        resolve(lease);
        return held;
      }).catch(reject);
    });
  }

  /** 判断页面导航是否允许恢复复制的 sessionStorage。
   * 仅浏览器刷新属于当前标签页恢复；复制标签页通常是 navigate，必须新建服务端会话。
   * 无法获取导航类型时采取新建策略，避免把复制的标识误当作当前标签页身份。
   * @returns 是否允许恢复
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  function canRestoreSession() {
    var entries = typeof performance !== 'undefined' && performance.getEntriesByType ? performance.getEntriesByType('navigation') : [];
    return entries[0] && entries[0].type === 'reload';
  }

  /** 获取当前 browsing context 的身份，而不是从可复制存储推断标签页身份。
   * window.name 在同一标签页刷新时保持，复制标签页通常获得新的 browsing context。
   * @returns 当前标签页身份
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  function ensureTabId() {
    var name = typeof window !== 'undefined' && typeof window.name === 'string' ? window.name : '';
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(name)) {
      name = 'iar-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      if (typeof window !== 'undefined') { try { window.name = name; } catch (err) { /* 后续会话仍会安全新建。 */ } }
    }
    return name;
  }

  /** 恢复标签页会话；复制标签页必须先原子占用，不能共享。
   * Web Locks 不可用时拒绝初始化，不退回共享会话。
   * 缓存标识先限制字符和长度，再尝试获取对应的锁。
   * 新会话标识也需校验并占锁后才能持久化。
   * @returns 会话可用时完成的 Promise
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  function initializeSession() {
    if (!navigator.locks || !navigator.locks.request) return Promise.reject(new Error('session_lock_unavailable'));
    tabId = ensureTabId();
    var canRestore = canRestoreSession();
    var storedSession = sessionStorage.getItem(SESSION_KEY);
    var reloadMarker = sessionStorage.getItem(RELOAD_KEY);
    var previousTabId = sessionStorage.getItem(TAB_KEY);
    var previous = canRestore && reloadMarker === storedSession && previousTabId === tabId ? storedSession : null;
    if (!/^[A-Za-z0-9_-]{32}$/.test(previous || '')) previous = null;
    try { sessionStorage.removeItem(RELOAD_KEY); } catch (err) { /* 失败时不影响本次会话隔离。 */ }
    if (!previous) { try { sessionStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(TAB_KEY); } catch (err) { /* 失败时后续写入仍会再次验证。 */ } }
    return (previous ? claimSession(previous) : Promise.resolve(null)).then(function (lease) {
      if (lease) { sessionLease = lease; sessionId = previous; return; }
      return fetch('/api/sessions', { method: 'POST' }).then(checkResponse).then(function (res) { return res.json(); }).then(function (body) {
        if (!/^[A-Za-z0-9_-]{32}$/.test(body.sessionId)) throw new Error('invalid_session');
        return claimSession(body.sessionId).then(function (createdLease) {
          if (!createdLease) return cleanupCreatedSession(body.sessionId, new Error('session_lock_unavailable'));
          sessionLease = createdLease;
          sessionId = body.sessionId;
          try { sessionStorage.setItem(SESSION_KEY, sessionId); sessionStorage.setItem(TAB_KEY, tabId); }
          catch (error) { return cleanupCreatedSession(body.sessionId, error); }
        }, function (error) { return cleanupCreatedSession(body.sessionId, error); });
      });
    });
  }

  /** 清理创建后未能完成初始化的会话，并释放当前标签页的锁。
   * 删除失败不覆盖初始化原因，避免页面误报为已建立会话。
   * @param id - 刚创建的服务端会话标识
   * @param error - 初始化失败原因
   * @returns 必定拒绝的 Promise
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  function cleanupCreatedSession(id, error) {
    if (sessionLease) { sessionLease.release(); sessionLease = null; }
    sessionId = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch (ignored) { /* 尽力清理本地标识。 */ }
    try { sessionStorage.removeItem(TAB_KEY); } catch (ignored) { /* 尽力清理标签页绑定。 */ }
    return fetch('/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' }).catch(function () {}).then(function () { throw error; });
  }

  /** 只为当前标签页的真实刷新留下恢复凭据。
   * 复制标签页获得的是初始化时的存储快照，不会获得原标签页后续写入的标记。
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  function markReloadableSession() {
    if (!sessionReady || sessionExpired || !sessionId) return;
    try { sessionStorage.setItem(RELOAD_KEY, sessionId); } catch (err) { /* 无法写入时下次按新会话处理。 */ }
  }

  /** 清除从后退/前进缓存恢复页面留下的刷新标记。
   * 页面仍在当前标签页继续运行时不应把旧 marker 复制给新标签页。
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  function clearReloadMarker() {
    try { sessionStorage.removeItem(RELOAD_KEY); } catch (err) { /* 清理失败时下一次初始化仍会校验导航类型。 */ }
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('pagehide', markReloadableSession);
    window.addEventListener('pageshow', clearReloadMarker);
  }

