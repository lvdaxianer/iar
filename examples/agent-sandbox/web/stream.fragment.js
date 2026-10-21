  // 阶段标签折叠在统一的 Thinking 指示器中，仅显示当前阶段短词。
  // 收到增量后整体移除指示器，避免把处理状态混入正文。
  // 没有收到内容时保留指示器，便于区分网络等待与回复生成。
  let STAGE_LABELS = {
    semantic: '理解意图',
    route: '路由选择',
    action: '执行插件',
    response: '生成回复'
  };

  /** 创建流式助手气泡，管理 Thinking 指示器和当前回复。
   * 流式期间使用纯文本追加，防止部分 HTML 被执行。
   * 只有终态结果到达时才将内容转换为安全 Markdown。
   * 断流时调用 remove，避免半条回复被误认成成功结果。
   * @returns 本次请求独有的气泡操作集合
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  function createStreamBubble() {
    var div = document.createElement('div');
    div.className = 'msg bot';
    var textEl = document.createElement('div');
    textEl.className = 'md-body';
    var thinking = createThinkingIndicator();
    div.appendChild(textEl);
    div.appendChild(thinking.stageEl);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    var state = { div: div, textEl: textEl, stageEl: thinking.stageEl, stageText: thinking.stageText, gotDelta: false };
    return {
      setStage: function (stage) { if (!state.gotDelta && STAGE_LABELS[stage]) state.stageText.textContent = '· ' + STAGE_LABELS[stage]; },
      appendDelta: function (text) { appendStreamDelta(state, text); },
      finalize: function (result) { finalizeStreamBubble(state, result); },
      remove: function () { div.remove(); }
    };
  }

  /** 创建流式气泡的阶段指示器。 */
  function createThinkingIndicator() {
    var stageEl = document.createElement('span');
    stageEl.className = 'thinking';
    var dots = document.createElement('span');
    dots.className = 'thinking-dots';
    dots.appendChild(document.createElement('i'));
    dots.appendChild(document.createElement('i'));
    dots.appendChild(document.createElement('i'));
    var label = document.createElement('span');
    label.className = 'thinking-label';
    label.textContent = 'Thinking';
    var stageText = document.createElement('span');
    stageText.className = 'thinking-stage';
    stageEl.appendChild(dots);
    stageEl.appendChild(label);
    stageEl.appendChild(stageText);
    return { stageEl: stageEl, stageText: stageText };
  }

  /** 增量以纯文本显示，直到终态才进行 Markdown 渲染。
   * @param state - 当前气泡及阶段
   * @param text - 收到的增量
   * @returns 无返回值
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  function appendStreamDelta(state, text) {
    if (!state.gotDelta) { state.gotDelta = true; state.stageEl.remove(); }
    state.textEl.textContent += text;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /** 展示终态；超限时用明确的不完整说明替换截断内容。
   * 已执行动作即使回复超限仍展示执行状态，避免用户重复操作。
   * 尚未执行的失败和需要澄清使用不同状态文字。
   * 待确认终态从服务端快照构建绑定 actionId 的确认控件。
   * 没有终态时不将当前气泡渲染为完整回复。
   * Markdown 渲染仅发生在终态之后；原始文本在替换 innerHTML 前快照，
   * 渲染后的 textContent 会丢失换行与标记，不能直接写入历史。
   * @param state - 当前气泡及阶段
   * @param result - 服务端最终结果
   * @returns 无返回值
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  function finalizeStreamBubble(state, result) {
    state.stageEl.remove();
    if (!result) return;
    lastReplySource = { direct_function: 'Function 直出', response_model: 'Response Model', pi_agent: 'Pi Agent', none: '无回复' }[result.replySource] || null;
    if ((state.textEl.textContent.length === 0 || result.reasonCode === 'model_response_too_large') && result.reply) state.textEl.textContent = result.reply;
    var rawText = state.textEl.textContent;
    state.textEl.innerHTML = renderMarkdown(rawText);
    var sourceMeta = lastReplySource || '来源未知';
    document.getElementById('routeReplySource').textContent = sourceMeta;
    var metaText = result.reasonCode === 'model_response_too_large' && result.status === 'executed' ? '已执行 · 回复不完整 · ' + sourceMeta : result.status === 'executed'
      ? '已执行 · ' + (result.route && result.route.functionId ? result.route.functionId : '') + ' · ' + sourceMeta
      : result.status === 'awaiting_confirmation' ? '等待确认 · ' + sourceMeta
      : result.status === 'agent' ? 'Pi 兜底 · ' + sourceMeta
      : result.status === 'clarification' ? '需要澄清 · ' + sourceMeta : '失败 · ' + sourceMeta;
    appendMessageMeta(state.div, metaText);
    recordConversation('bot', rawText, metaText);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (result.status === 'awaiting_confirmation' && result.pending) runConfirm(result.pending);
  }

  /** 使用 SSE 流式聊天，明确不自动重试。
   * 在网络断开前，服务端可能已经执行了有副作用的动作。
   * 标识由 sessionFetch 绑定，消息只发送给当前会话。
   * @param text - 用户提交的消息
   * @returns 收到完整终态后完成的 Promise
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  function streamChat(text) {
    return sessionFetch('/chat?stream=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    }).then(readStreamResponse);
  }

  /** 建立单次 SSE 读取状态；出错时移除不完整气泡。
   * HTTP 失败或缺少响应体均不能表示业务已完成。
   * 每个响应独立持有 reader、解码器与未完成帧缓冲。
   * @param res - 聊天响应
   * @returns 读取完成的 Promise
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  function readStreamResponse(res) {
    if (!res.ok || !res.body) throw new Error('stream unavailable');
    var state = { bubble: createStreamBubble(), reader: res.body.getReader(), decoder: new TextDecoder(), buffer: '', result: null };
    return pumpStream(state).catch(function (err) { state.bubble.remove(); throw err; });
  }

  /** 顺序读取分块，只有收到 done 后才完成气泡。
   * SSE 分隔符可能跨网络分块，未完成的部分保留到下次读取。
   * 流结束但未收到 done 时报告不完整，不渲染为成功。
   * @param state - 本次流的缓冲、读取器和界面状态
   * @returns 读取完成的 Promise
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  function pumpStream(state) {
    return state.reader.read().then(function (chunk) {
      if (chunk.done) {
        if (!state.result) throw new Error('stream incomplete');
        state.bubble.finalize(state.result);
        return;
      }
      state.buffer += state.decoder.decode(chunk.value, { stream: true });
      var blocks = state.buffer.split('\n\n');
      state.buffer = blocks.pop() || '';
      blocks.forEach(function (block) { block.split('\n').forEach(function (line) { handleStreamLine(state, line); }); });
      return pumpStream(state);
    });
  }

  /** 消费单个 SSE 数据行，不将非法 JSON 视为终态。
   * stage 和 delta 可以在最终业务结果之前到达。
   * error 是可见说明，不替代必须存在的 done 终态。
   * @param state - 本次流的界面和结果状态
   * @param line - 原始数据行
   * @returns 无返回值
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  function handleStreamLine(state, line) {
    if (line.indexOf('data: ') !== 0) return;
    var event;
    try { event = JSON.parse(line.slice('data: '.length)); } catch (err) { return; }
    if (event.type === 'stage') state.bubble.setStage(event.stage);
    else if (event.type === 'delta') state.bubble.appendDelta(event.text);
    else if (event.type === 'done') state.result = event.result;
    else if (event.type === 'error') state.bubble.appendDelta(event.message || '处理出错');
  }

