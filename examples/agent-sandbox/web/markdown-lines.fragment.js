  /** 结束当前 Markdown 列表，供段落、标题和文末复用。
   * @param state - 渲染输出及列表状态
   * @returns 无返回值
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  function closeMarkdownLists(state) {
    if (state.inUl) { state.html += '</ul>'; state.inUl = false; }
    if (state.inOl) { state.html += '</ol>'; state.inOl = false; }
  }

  /** 按行渲染列表和普通内容；输入已经完成 HTML 转义。
   * 列表在普通段落及文末关闭，防止标签跨越不相关内容。
   * @param lines - 已转义的文本行
   * @returns 安全子集生成的 HTML
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  function renderMarkdownLines(lines) {
    var state = { html: '', inUl: false, inOl: false };
    lines.forEach(function (line) { renderMarkdownLine(state, line); });
    closeMarkdownLists(state);
    return state.html;
  }

  /** 将一个文本行追加到列表、标题或段落。
   * @param state - 输出及列表状态
   * @param line - 已转义文本行
   * @returns 无返回值
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  function renderMarkdownLine(state, line) {
    var trimmed = line.trim();
    var ulMatch = /^[-*]\s+(.+)/.exec(trimmed);
    var olMatch = /^\d+[.、)]\s*(.+)/.exec(trimmed);
    if (ulMatch) { appendMarkdownListItem(state, 'ul', ulMatch[1]); return; }
    if (olMatch) { appendMarkdownListItem(state, 'ol', olMatch[1]); return; }
    closeMarkdownLists(state);
    if (trimmed === '') return;
    var heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      var level = heading[1].length + 2;
      state.html += '<h' + level + '>' + inlineMd(heading[2]) + '</h' + level + '>';
      return;
    }
    state.html += '<p>' + inlineMd(line) + '</p>';
  }

  /** 切换列表类型并追加列表项。
   * @param state - 输出及列表状态
   * @param kind - 有序或无序列表标签
   * @param content - 已转义的行内内容
   * @returns 无返回值
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  function appendMarkdownListItem(state, kind, content) {
    if (kind === 'ul' && state.inOl) { state.html += '</ol>'; state.inOl = false; }
    if (kind === 'ol' && state.inUl) { state.html += '</ul>'; state.inUl = false; }
    if (kind === 'ul' && !state.inUl) { state.html += '<ul>'; state.inUl = true; }
    if (kind === 'ol' && !state.inOl) { state.html += '<ol>'; state.inOl = true; }
    state.html += '<li>' + inlineMd(content) + '</li>';
  }
