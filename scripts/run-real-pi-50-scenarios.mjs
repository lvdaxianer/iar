/**
 * 在一个 Pi/IAR 会话内执行用户提供的 50 个话题突变场景。
 *
 * 这是验证工具：只读取 Pi Host/Bridge 公共 HTTP 协议，不参与业务路由或执行。
 * 场景文件通过 REAL_SCENARIO_FILE 传入，默认使用仓库内的 Agent Sandbox 清单。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
import { readFile, writeFile } from 'node:fs/promises';

const piHostBase = process.env.PI_HOST_URL ?? 'http://127.0.0.1:8878';
const bridgeBase = process.env.PI_BRIDGE_URL ?? 'http://127.0.0.1:8787';
const scenarioFile = process.env.REAL_SCENARIO_FILE ?? 'docs/agent-sandbox-test-cases.md';
const piSessionId = process.env.PI_SESSION_ID ?? `real-50-${Date.now().toString(36)}`;
const requestTimeoutMs = Number(process.env.PI_SCENARIO_TIMEOUT_MS ?? 180_000);
const eventTimeoutMs = Number(process.env.PI_SCENARIO_EVENT_TIMEOUT_MS ?? 30_000);
const reportFile = process.env.REAL_SCENARIO_REPORT;
const selectedScenarioIds = new Set((process.env.PI_SCENARIO_IDS ?? '').split(',').map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0));

const expectedFunctions = new Map([
  [1, 'ticket.create'], [2, 'api.gateway'], [3, 'report.center'], [4, 'dip.manage'], [5, 'job.monitor'], [6, 'dataset.query'], [7, 'account.privilege'], [8, 'system.status'], [9, 'human.transfer'],
  [13, 'ticket.create'], [14, 'ticket.create'], [15, 'ticket.create'], [16, 'api.gateway'], [17, 'api.gateway'], [18, 'api.gateway'], [19, 'api.gateway'], [20, 'report.center'], [21, 'report.center'], [22, 'report.center'], [23, 'dip.manage'], [24, 'dip.manage'], [25, 'dataset.query'], [26, 'account.privilege'], [27, 'account.privilege'], [28, 'job.monitor'], [29, 'human.transfer'], [30, 'knowledge.query'],
  [31, 'ticket.create'], [32, 'api.gateway'], [33, 'report.center'], [34, 'dip.manage'], [35, 'dataset.query'], [36, 'job.monitor'], [37, 'account.privilege'], [38, 'system.status'],
  [40, 'report.center'], [41, 'api.gateway'], [42, 'dip.manage'], [44, 'account.privilege'], [46, 'job.monitor'], [47, 'account.privilege'], [48, 'ticket.create'], [49, 'api.gateway'], [50, 'human.transfer']
]);

const catalogChecks = new Map([
  [1, ['create', 'progress', 'search', '创建', '进度', '检索']], [2, ['stats', 'limit', 'search', '统计', '限流', '检索']], [3, ['list', 'export', '目录', '导出']], [4, ['list', 'detail', 'rerun', 'stop', '列', '详情', '重跑', '停止']], [6, ['search', 'lineage', '检索', '血缘']], [7, ['mine', 'grant', '权限', '授权']], [9, ['search', 'transfer', '知识', '转接']], [11, ['集成', '资产', '报表', 'DIP']], [41, ['stats', 'limit', '统计', '调整', '配额']], [46, ['status', 'logs', '状态', '日志']], [48, ['search', 'progress', '知识', '单号', '进度']], [49, ['search', 'stats', '知识', '统计']], [50, ['search', 'transfer', '知识', '转接']]
]);

const slotChecks = new Map([
  [13, ['描述', '内容', '说明', '参数']], [15, ['单号', '工单']], [16, ['多少', '数值', '目标值']], [17, ['哪个', '接口', '目标', '参数']], [18, ['目标', '数值', '多少']], [20, ['哪张', '报表', '目录']], [22, ['xlsx', 'csv', 'pdf', '参数']], [23, ['任务', '列出']], [24, ['任务', '确认', '风险']], [25, ['表', '表名']], [26, ['角色', '资源', '参数']], [27, ['角色', '范围', '支持', '参数']], [28, ['任务']], [29, ['原因', '确认']], [30, ['关键词', '检索', '搜']]
]);

const capabilityBoundaryScenarios = new Set([12, 31, 32, 33, 34, 35, 36, 37, 38]);
const actionSafetyScenarios = new Set([1, 3, 4, 7, 9, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23, 24, 26, 27, 29, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 44, 45, 50]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 解析响应正文；错误正文只在本地验证报告中保留有限长度。 */
async function asJson(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { raw: text.slice(0, 400) }; }
}

/** 发送带超时的 JSON 请求。 */
async function request(url, method, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal
    });
    return { status: response.status, body: await asJson(response) };
  } finally { clearTimeout(timer); }
}

/** 将 Markdown 场景解析成用户轮次与轮后控制动作。 */
function parseScenarios(markdown) {
  const sections = [...markdown.matchAll(/^### 场景 (\d+)[^\n]*\n([\s\S]*?)(?=^### 场景 |^## 评判口径|(?![\s\S]))/gm)];
  return sections.map((match) => parseScenario(Number(match[1]), match[2])).filter((scenario) => scenario.turns.length > 0);
}

/** 解析单组场景中的 fenced user turns 和确认/压缩控制。 */
function parseScenario(id, body) {
  const turns = [];
  const blocks = [...body.matchAll(/```(?:text)?\n([\s\S]*?)```/g)];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const afterStart = block.index + block[0].length;
    const afterEnd = index + 1 < blocks.length ? blocks[index + 1].index : body.length;
    const between = body.slice(afterStart, afterEnd);
    const controls = [];
    const standaloneControls = between.split(/\r?\n/).map((line) => line.trim());
    if (standaloneControls.includes('【确认】')) controls.push('confirm');
    if (standaloneControls.includes('【取消】')) controls.push('cancel');
    turns.push({ text: block[1].trim().replace(/（切[^）]*）/g, '').trim(), controls, compactAfter: /触发压缩|点「触发压缩」/.test(between) });
  }
  return { id, turns };
}

/** 连接一次 SSE；整次 50 场景运行不重建连接或 Pi 会话。 */
async function connectEvents() {
  const controller = new AbortController();
  const response = await fetch(`${piHostBase}/api/pi-host/events?session=${encodeURIComponent(piSessionId)}`, { signal: controller.signal });
  if (!response.ok || !response.body) throw new Error(`events_${response.status}`);
  const events = [];
  const reader = response.body.getReader();
  (async () => {
    let buffer = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += new TextDecoder().decode(chunk.value, { stream: true });
        buffer = parseSseChunk(buffer, events);
      }
    } catch { /* 由 close 收束读取。 */ }
  })();
  await waitFor(() => events.some((event) => event.type === 'ready'), events, 10_000);
  return { events, close: () => controller.abort() };
}

/** 解析 SSE 的完整事件块。 */
function parseSseChunk(buffer, events) {
  let remaining = buffer;
  while (true) {
    const boundary = remaining.indexOf('\n\n');
    if (boundary < 0) break;
    const block = remaining.slice(0, boundary).replace(/\r/g, '');
    remaining = remaining.slice(boundary + 2);
    let type = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (data) {
      try { events.push({ type, data: JSON.parse(data) }); } catch { events.push({ type, data }); }
    }
  }
  return remaining;
}

/** 等待 SSE 事件条件。 */
async function waitFor(predicate, events, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('event_timeout');
    await sleep(50);
  }
}

/** 发送一轮用户输入并等待本轮终态事件。 */
async function chat(connection, text) {
  const before = connection.events.length;
  const startedAt = Date.now();
  const result = await request(`${piHostBase}/api/pi-host/chat`, 'POST', { session: piSessionId, text });
  if (result.status >= 300) throw new Error(`chat_${result.status}`);
  await waitFor(() => connection.events.slice(before).some((event) => ['entry', 'piDone', 'notify'].includes(event.type)), connection.events, eventTimeoutMs).catch(() => undefined);
  const turnEvents = connection.events.slice(before);
  return {
    elapsedMs: Date.now() - startedAt,
    result: result.body,
    route: [...turnEvents].reverse().find((event) => event.type === 'route')?.data,
    entry: [...turnEvents].reverse().find((event) => event.type === 'entry')?.data?.data,
    piDone: [...turnEvents].reverse().find((event) => event.type === 'piDone')?.data,
    pending: [...turnEvents].reverse().find((event) => event.type === 'confirm')?.data,
    stateEvents: turnEvents.filter((event) => event.type === 'state').length,
    warnings: turnEvents.filter((event) => event.type === 'notify' && event.data?.type === 'warning').map((event) => event.data?.code ?? event.data?.message)
  };
}

/** 处理 Pi Host 的确认/取消命令。 */
async function confirm(connection, accepted) {
  const before = connection.events.length;
  const result = await request(`${piHostBase}/api/pi-host/confirm`, 'POST', { session: piSessionId, accepted });
  if (result.status >= 300) throw new Error(`confirm_${result.status}`);
  await waitFor(() => connection.events.slice(before).some((event) => ['entry', 'notify'].includes(event.type)), connection.events, eventTimeoutMs).catch(() => undefined);
  const turnEvents = connection.events.slice(before);
  return { accepted, result: result.body, pending: [...turnEvents].reverse().find((event) => event.type === 'confirm')?.data ?? null };
}

/** 通过已有 IAR session 的维护接口触发页面同款压缩动作。 */
async function compact(iarSessionId) {
  const result = await request(`${bridgeBase}/api/sessions/${encodeURIComponent(iarSessionId)}/compact`, 'POST', {});
  if (result.status >= 300) throw new Error(`compact_${result.status}`);
  return result.body;
}

/** 打开一次固定 Pi→IAR 映射，之后所有轮次复用它。 */
async function openBridge() {
  const result = await request(`${bridgeBase}/api/bridge/v1/sessions`, 'POST', { piSessionId });
  if (result.status >= 300 || typeof result.body.iarSessionId !== 'string') throw new Error(`bridge_open_${result.status}`);
  return result.body.iarSessionId;
}

/** 读取当前公开 state，并检查页面复制所需字段及敏感字段白名单。 */
async function readAndValidateState(iarSessionId, minimumTurnCount, minimumFactCount) {
  const result = await request(`${bridgeBase}/api/bridge/v1/sessions/${encodeURIComponent(iarSessionId)}/state`, 'GET');
  if (result.status >= 300) throw new Error(`bridge_state_${result.status}`);
  const state = result.body;
  const forbidden = ['userText', 'assistantText', 'rawPrompt', 'reasoning', 'scopeHash', 'actionInput', 'collected', 'presentation'];
  const forbiddenFields = forbidden.filter((field) => hasKey(state, field));
  const turns = state.structuredContext?.conversationTurns?.turns;
  const facts = state.structuredContext?.factHistory?.records;
  const workflowState = state.workflowState;
  const checks = {
    structuredContext: state.structuredContext?.schemaVersion === 'iar.pi-structured-context/v1',
    workflowState: workflowState?.mapVersion === 'iar.workflow-map/v1',
    turns: Array.isArray(turns) && turns.length >= minimumTurnCount,
    facts: Array.isArray(facts) && facts.length >= minimumFactCount,
    forbiddenFields: forbiddenFields.length === 0
  };
  return { state, checks, forbiddenFields, turnCount: Array.isArray(turns) ? turns.length : 0, factCount: Array.isArray(facts) ? facts.length : 0 };
}

/** 只按对象键名检查敏感字段，避免把 workflow 的 kind=input 误判为原始输入。 */
function hasKey(value, key) {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, key));
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([name, child]) => name === key || hasKey(child, key));
}

/** 将本轮结果压缩为可审计的技术验证摘要。 */
function summarizeTurn(turn, state) {
  const body = turn.output.result && typeof turn.output.result === 'object' ? turn.output.result : {};
  const route = body.route ?? turn.output.route ?? {};
  const entryContent = typeof turn.output.entry === 'string'
    ? turn.output.entry
    : turn.output.entry && typeof turn.output.entry === 'object' && typeof turn.output.entry.content === 'string'
      ? turn.output.entry.content
      : '';
  const piReply = typeof turn.output.piDone === 'string' ? turn.output.piDone : '';
  const reply = typeof body.reply === 'string' ? body.reply : entryContent || piReply;
  return {
    text: turn.text,
    controls: turn.controls,
    elapsedMs: turn.output.elapsedMs,
    disposition: body.disposition ?? route.disposition ?? body.result?.action ?? 'unknown',
    reasonCode: body.reasonCode ?? route.reasonCode ?? 'none',
    functionId: route.functionId,
    pluginId: route.pluginId,
    pending: Boolean(body.pending ?? turn.output.pending),
    reply: reply.slice(0, 500),
    stateEvents: turn.output.stateEvents,
    warnings: turn.output.warnings,
    stateChecks: state.checks,
    turnCount: state.turnCount,
    factCount: state.factCount
  };
}

/** 对真实模型结果做稳定语义断言；不比较回复全文，只检查安全处置和有限目录/槽位证据。 */
function assertScenarioTurn(scenarioId, turn, summary) {
  const failures = [];
  const functionId = summary.functionId;
  const reply = summary.reply;
  const blocked = ['clarification', 'awaiting_confirmation', 'pass_through', 'agent'].includes(summary.disposition);
  const expectedFunction = expectedFunctions.get(scenarioId);
  if (expectedFunction !== undefined && functionId !== undefined && functionId !== expectedFunction) failures.push(`wrong_function:${functionId}`);
  if (actionSafetyScenarios.has(scenarioId) && ['handled', 'executed'].includes(summary.disposition)) failures.push(`unsafe_disposition:${summary.disposition}`);
  if (capabilityBoundaryScenarios.has(scenarioId) && !/(不支持|不具备|无法|不能|能力|只读|审批|替代|引导|没有)/u.test(reply)) failures.push('missing_capability_boundary');
  const catalog = catalogChecks.get(scenarioId);
  if (catalog !== undefined && !catalog.some((keyword) => reply.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()))) failures.push(`missing_catalog:${catalog.join('|')}`);
  const slots = slotChecks.get(scenarioId);
  if (slots !== undefined && !slots.some((keyword) => reply.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()))) failures.push(`missing_slot:${slots.join('|')}`);
  if (actionSafetyScenarios.has(scenarioId) && !blocked && !summary.pending) failures.push('not_blocked_before_completion');
  return failures;
}

/** 在同一 Pi/IAR 会话内清掉场景间的待确认/参数收集状态，不创建或切换会话。 */
async function clearScenarioBoundary(connection, iarSessionId) {
  const current = await readAndValidateState(iarSessionId, 0, 0);
  const context = current.state.structuredContext ?? {};
  const hasTopLevelPendingAction = current.state.pending !== null && typeof current.state.pending === 'object' && typeof current.state.pending.actionId === 'string';
  if (hasTopLevelPendingAction || context.pending?.status === 'required' || context.confirmation?.state === 'awaiting') await confirm(connection, false);
  const afterConfirm = await readAndValidateState(iarSessionId, 0, 0);
  const nextContext = afterConfirm.state.structuredContext ?? {};
  if (nextContext.collection !== undefined || nextContext.pending?.kind === 'slot' || nextContext.pending?.status === 'required') await chat(connection, '取消当前流程');
}

async function main() {
  const markdown = await readFile(scenarioFile, 'utf8');
  const scenarios = parseScenarios(markdown).filter((scenario) => selectedScenarioIds.size === 0 || selectedScenarioIds.has(scenario.id));
  if (scenarios.length !== 50 && selectedScenarioIds.size === 0) throw new Error(`scenario_count_${scenarios.length}`);
  const iarSessionId = await openBridge();
  const connection = await connectEvents();
  const report = [];
  let expectedTurnCount = 0;
  let minimumTurnCount = 0;
  let minimumFactCount = 0;
  try {
    for (const scenario of scenarios) {
      const rows = [];
      const scenarioFailures = [];
      for (const turn of scenario.turns) {
        expectedTurnCount += 1;
        const output = await chat(connection, turn.text);
        const state = await readAndValidateState(iarSessionId, minimumTurnCount, minimumFactCount);
        minimumTurnCount = state.turnCount;
        minimumFactCount = state.factCount;
        const summary = summarizeTurn({ text: turn.text, controls: turn.controls, output }, state);
        summary.semanticFailures = assertScenarioTurn(scenario.id, turn, summary);
        scenarioFailures.push(...summary.semanticFailures.map((failure) => `turn:${turn.text}:${failure}`));
        rows.push(summary);
        for (const control of turn.controls) {
          const confirmation = await confirm(connection, control === 'confirm');
          const after = await readAndValidateState(iarSessionId, minimumTurnCount, minimumFactCount);
          minimumTurnCount = after.turnCount;
          minimumFactCount = after.factCount;
          rows.push({ confirmation, stateChecks: after.checks, turnCount: after.turnCount, factCount: after.factCount });
        }
        if (turn.compactAfter) {
          const compacted = await compact(iarSessionId);
          const after = await readAndValidateState(iarSessionId, minimumTurnCount, minimumFactCount);
          minimumTurnCount = after.turnCount;
          minimumFactCount = after.factCount;
          rows.push({ compacted: true, compactSchemaVersion: compacted.schemaVersion, stateChecks: after.checks, turnCount: after.turnCount, factCount: after.factCount });
        }
      }
      const failedChecks = rows.flatMap((row) => row.stateChecks ? Object.entries(row.stateChecks).filter(([, value]) => !value).map(([key]) => key) : []).concat(scenarioFailures);
      report.push({ scenario: scenario.id, turnCount: scenario.turns.length, failedChecks: [...new Set(failedChecks)], rows });
      process.stdout.write(`${JSON.stringify(report.at(-1))}\n`);
      await clearScenarioBoundary(connection, iarSessionId);
    }
  } finally { connection.close(); }
  const result = { schemaVersion: 'iar.real-pi-50-scenarios/v1', piSessionId, iarSessionId, singleSession: true, scenarioCount: report.length, turnCount: expectedTurnCount, failedScenarios: report.filter((item) => item.failedChecks.length > 0).map((item) => item.scenario), report };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (reportFile) await writeFile(reportFile, serialized, 'utf8');
  process.stdout.write(serialized);
  if (result.failedScenarios.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`real_pi_50_scenarios_failed:${error instanceof Error ? error.message : 'unknown'}\n`);
  process.exitCode = 1;
});
