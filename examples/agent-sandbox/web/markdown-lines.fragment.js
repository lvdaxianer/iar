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
    for (var index = 0; index < lines.length;) {
      var consumed = renderMarkdownTable(state, lines, index);
      if (consumed > 0) { index += consumed; continue; }
      renderMarkdownLine(state, lines[index]);
      index += 1;
    }
    closeMarkdownLists(state);
    return state.html;
  }

  /** 识别并渲染有限 GFM 表格；输入已经完成 HTML 转义。
   * @param state - 输出及列表状态
   * @param lines - 已转义的文本行
   * @param start - 表头所在行
   * @returns 消耗的行数；非表格返回 0
   * @author lvdaxianer@yeah.net @date 2026-10-22
   */
  function renderMarkdownTable(state, lines, start) {
    if (start + 1 >= lines.length) return 0;
    var header = splitMarkdownTableRow(lines[start]);
    var delimiter = splitMarkdownTableRow(lines[start + 1]);
    if (!header || !delimiter || header.length === 0 || delimiter.length !== header.length || !delimiter.every(isMarkdownTableDelimiter)) return 0;
    var table = collectMarkdownTableRows(lines, start + 2);
    closeMarkdownLists(state);
    state.html += renderMarkdownTableHtml(header, table.rows);
    return table.nextIndex - start;
  }

  /** 收集连续的数据行，遇到普通 Markdown 行时停止。
   * @param lines - 已转义的文本行
   * @param start - 数据行起始位置
   * @returns 数据行及下一段 Markdown 的位置
   * @author lvdaxianer@yeah.net @date 2026-10-22
   */
  function collectMarkdownTableRows(lines, start) {
    var rows = [];
    var index = start;
    while (index < lines.length) {
      var row = splitMarkdownTableRow(lines[index]);
      if (!row) break;
      rows.push(row);
      index += 1;
    }
    return { rows: rows, nextIndex: index };
  }

  /** 将表头和数据行渲染为安全的表格 HTML。
   * @param header - 表头单元格
   * @param rows - 数据行单元格
   * @returns 安全表格 HTML
   * @author lvdaxianer@yeah.net @date 2026-10-22
   */
  function renderMarkdownTableHtml(header, rows) {
    var html = '<div class="md-table"><table><thead><tr>';
    html += header.map(function (cell) { return '<th>' + inlineMd(cell) + '</th>'; }).join('');
    html += '</tr></thead><tbody>';
    rows.forEach(function (row) {
      html += '<tr>' + header.map(function (_, column) { return '<td>' + inlineMd(row[column] || '') + '</td>'; }).join('');
      html += '</tr>';
    });
    return html + '</tbody></table></div>';
  }

  /** 读取一行管线分隔单元格；不符合表格形状时返回 undefined。
   * @param line - 已转义的 Markdown 行
   * @returns 去除外层管线并清理空白的单元格
   * @author lvdaxianer@yeah.net @date 2026-10-22
   */
  function splitMarkdownTableRow(line) {
    var trimmed = line.trim();
    if (trimmed.indexOf('|') < 0) return undefined;
    if (trimmed[0] === '|') trimmed = trimmed.slice(1);
    if (trimmed[trimmed.length - 1] === '|') trimmed = trimmed.slice(0, -1);
    return trimmed.split('|').map(function (cell) { return cell.trim(); });
  }

  /** 判断单元格是否为有限 GFM 表格分隔符。
   * @param cell - 已转义的分隔单元格
   * @returns 是否符合分隔符语法
   * @author lvdaxianer@yeah.net @date 2026-10-22
   */
  function isMarkdownTableDelimiter(cell) { return /^:?-{3,}:?$/.test(cell); }

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
