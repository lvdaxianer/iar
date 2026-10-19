  /** 追加一条聊天消息，用户输入始终作为纯文本呈现。
   * 助手内容通过受限 Markdown 渲染器转义。
   * @param role - 用户或助手角色
   * @param text - 消息正文
   * @param meta - 可选状态文字
   * @returns 新建的消息容器
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  function appendMsg(role, text, meta) {
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
    if (meta) appendMessageMeta(div, meta);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  /** 在消息尾部显示动作或回复状态。
   * @param div - 消息容器
   * @param text - 用户可见状态
   * @returns 无返回值
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  function appendMessageMeta(div, text) {
    var span = document.createElement('span');
    span.className = 'meta';
    span.textContent = text;
    div.appendChild(span);
  }

  /** 显示动作详情并绑定当前动作的确认或取消。
   * 操作数据用 textContent 展示，避免输入成为 HTML。
   * 控件的忙碌状态由 confirmButton 与 setBusy 共同维护。
   * @param pending - 当前会话的待确认动作
   * @param onDone - 布尔确认结果回调
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  function showConfirmBox(pending, onDone) {
    var box = document.createElement('div');
    box.className = 'confirm-box';
    var title = document.createElement('div');
    title.textContent = '待确认动作：' + pending.functionId + ' / ' + pending.pluginId + '（风险等级 ' + pending.riskLevel + '）';
    var detail = document.createElement('div');
    detail.style.cssText = 'margin-top:6px;font-family:var(--mono);font-size:11px;color:var(--muted)';
    detail.textContent = JSON.stringify(pending.input);
    var actions = document.createElement('div');
    actions.className = 'actions';
    actions.appendChild(confirmButton('确认执行', 'ok', function () { box.remove(); onDone(true); }));
    actions.appendChild(confirmButton('取消', 'danger', function () { box.remove(); onDone(false); }));
    box.appendChild(title);
    box.appendChild(detail);
    box.appendChild(actions);
    messagesEl.appendChild(box);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /** 构造绑定当前忙碌状态的确认按钮，重复触发不会执行动作。
   * 即使外部脚本触发 click，处理器仍再次检查会话状态。
   * @param label - 按钮文字
   * @param style - 按钮样式
   * @param onClick - 已验证的操作回调
   * @returns 创建的按钮
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  function confirmButton(label, style, onClick) {
    var button = document.createElement('button');
    button.className = style;
    button.textContent = label;
    button.disabled = sessionBusy || !sessionReady || sessionExpired;
    button.onclick = function () { if (sessionBusy || !sessionReady || sessionExpired) return; onClick(); };
    return button;
  }

  /** 同步所有有副作用的控件，包括状态刷新时新建的确认框。
   * 失效和未就绪会话始终禁用控件，即使当前操作已结束。
   * @param busy - 当前页面是否有操作未结束
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  function setBusy(busy) {
    sessionBusy = busy;
    var disabled = busy || !sessionReady || sessionExpired;
    sendBtn.disabled = disabled;
    inputEl.disabled = disabled;
    document.getElementById('compactBtn').disabled = disabled;
    document.getElementById('resetBtn').disabled = disabled;
    document.querySelectorAll('.confirm-box button').forEach(function (button) { button.disabled = disabled; });
  }

  /** 发送与当前会话绑定的 JSON 操作。
   * 非成功响应由 sessionFetch 统一处理，不隐式重试。
   * @param path - 独立会话下的操作路径
   * @param body - 可选请求参数
   * @returns 解析后的响应对象 Promise
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  function api(path, body) {
    return sessionFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (res) { return res.json(); });
  }

