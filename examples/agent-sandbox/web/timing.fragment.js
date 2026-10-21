  /**
   * 将服务端毫秒耗时转换为紧凑的用户可读文本。
   * @param durationMs - 服务端毫秒耗时
   * @returns 用户可读的耗时，非法值返回空字符串
   * @author lvdaxianer@yeah.net
   * @date 2026-10-22
   */
  function formatTimingDuration(durationMs) {
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return '';
    if (durationMs < 1000) return Math.round(durationMs) + 'ms';
    return (durationMs / 1000).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1') + 's';
  }

  /**
   * 将完整 traceId 压缩为消息卡片可容纳的首尾片段。
   * @param traceId - 完整 traceId
   * @returns 消息卡片使用的短 traceId
   * @author lvdaxianer@yeah.net
   * @date 2026-10-22
   */
  function shortTraceId(traceId) {
    if (typeof traceId !== 'string' || traceId.length === 0) return '';
    return traceId.length <= 16 ? traceId : traceId.slice(0, 8) + '…' + traceId.slice(-6);
  }

  /**
   * 为状态 meta 附加服务端耗时和 traceId，并保留完整 traceId。
   * @param baseText - 原有状态与来源文字
   * @param timing - 服务端 timing 摘要
   * @returns 组合后的显示文字与完整 traceId
   * @author lvdaxianer@yeah.net
   * @date 2026-10-22
   */
  function formatTimingMeta(baseText, timing) {
    var text = baseText;
    var duration = formatTimingDuration(timing && timing.durationMs);
    var traceId = timing && typeof timing.traceId === 'string' && timing.traceId.length > 0 ? timing.traceId : '';
    if (duration) text += ' · 耗时 ' + duration;
    if (traceId) text += ' · trace ' + shortTraceId(traceId);
    return { text: text, traceId: traceId };
  }

  /**
   * 将完整 traceId 写入右侧 Timing 面板；缺失时恢复占位符。
   * @param timing - 服务端 timing 摘要
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-22
   */
  function renderTimingTrace(timing) {
    var traceEl = document.getElementById('timingTraceId');
    if (!traceEl) return;
    traceEl.textContent = timing && typeof timing.traceId === 'string' && timing.traceId.length > 0 ? timing.traceId : '-';
  }
