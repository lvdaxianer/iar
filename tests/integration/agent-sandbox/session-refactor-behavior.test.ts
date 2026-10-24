/** 会话职责拆分后的公开行为回归。
 * 使用真实 scripted 会话，而非替换路由、工作流或事件投影。
 * 普通与流式入口共享状态，但各自保留原本的结果及阶段协议。
 * 确认覆盖有动作和无动作两种条件，避免只检查成功路径。
 * reset 后的压缩和路由检查组件读取的是宿主的实时引用。
 * 每个用例独立构造和释放会话，不能依赖上一个用例的历史。
 * 网络故障、响应超限和取消的独立路径由可观察性测试覆盖。
 * 本文件不把组件内部实现细节当作业务行为断言。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';
import { requiresGatewayRateClarification } from '../../../examples/agent-sandbox/src/session-helpers.js';
import type { StreamEvent } from '../../../examples/agent-sandbox/src/session.js';

/* 同一脚本输入走两个公开入口，比较执行终态。
 * 流式阶段及 done 的顺序是客户端可观察协议，重构不能改变。
 * scripted 模式让结果不依赖外部模型网络或不确定的生成内容。
 * 普通入口和流式入口都必须报告动作已执行，避免路由实现分叉。
 * 阶段顺序覆盖语义、路由、动作和回复四个调用边界。
 * timing 必须在 done 前到达；done 必须是最后一个事件，且承载的结果与返回值完全一致。
 * 至少一个 delta 确保测试确实经历了流式正文输出路径。
 * finally 释放会话工作线程，即使事件断言失败也不会挂住进程。
 */
test('普通与流式对话保留执行结果及阶段顺序', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const normal = await session.turn('列出今天的集成任务');
    const events: StreamEvent[] = [];
    const streamed = await session.turnStreamed('列出今天的集成任务', (event) => events.push(event));
    assert.equal(normal.status, 'executed');
    assert.equal(streamed.status, 'executed');
    assert.deepEqual(events.filter((event) => event.type === 'stage').map((event) => event.stage),
      ['semantic', 'route', 'action', 'response']);
    assert.equal(events.at(-1)?.type, 'done');
    assert.deepEqual(events.at(-1)?.type === 'done' ? events.at(-1) : undefined, { type: 'done', result: streamed });
    assert.ok(events.some((event) => event.type === 'delta'));
    const timingIndex = events.findIndex((event) => event.type === 'timing');
    const doneIndex = events.findIndex((event) => event.type === 'done');
    assert.ok(timingIndex >= 0 && timingIndex < doneIndex, 'timing 必须先于 done 发送');
  } finally { session.dispose(); }
});

/* 空确认、取消和执行分别覆盖待确认动作的三种公开结果。
 * 取消和执行之后都检查状态，防止组合组件保留旧 pending。
 * 尚无动作时确认应返回稳定的 no_pending_confirmation 原因。
 * 第一轮高风险请求必须等待用户选择，而不是直接执行插件。
 * 拒绝动作后读取状态，验证宿主与组件看到相同的清空结果。
 * 第二轮重新创建动作，接受后要求返回 executed 而非重复取消。
 * 再次检查 pending，防止成功执行后旧确认框仍能指向原动作。
 * 每个场景结束都释放会话，测试不依赖其他用例留下的状态。
 */
test('待确认动作保留取消、执行及空确认错误行为', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const empty = await session.confirm(true);
    assert.equal(empty.status, 'failed');
    assert.equal(empty.reasonCode, 'no_pending_confirmation');
    assert.equal((await session.turn('帮我创建工单')).status, 'awaiting_confirmation');
    assert.equal((await session.confirm(false)).status, 'cancelled');
    assert.equal((await session.state()).pending, null);
    assert.equal((await session.turn('帮我创建工单')).status, 'awaiting_confirmation');
    assert.equal((await session.confirm(true)).status, 'executed');
    assert.equal((await session.state()).pending, null);
  } finally { session.dispose(); }
});

/* 重置替换事件存储；压缩必须读取替换后的实时状态，
 * 不能继续使用组件构造时捕获的旧存储引用。
 * 新会话没有足够事件，应返回明确的 insufficient_events。
 * 真实对话增加事件后，同一压缩入口不再报告事件不足。
 * reset 后再次压缩，如果旧引用仍存在就会观察到错误的旧事件。
 * 该测试只验证状态引用，不依赖具体摘要内容或模型措辞。
 * 资源释放放在 finally，失败时不会遗留会话工作线程。
 */
test('压缩组件始终读取重置后的当前事件存储', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    assert.equal((await session.compact()).reasonCode, 'insufficient_events');
    await session.turn('列出今天的集成任务');
    assert.notEqual((await session.compact()).reasonCode, 'insufficient_events');
    await session.reset();
    assert.equal((await session.compact()).reasonCode, 'insufficient_events');
  } finally { session.dispose(); }
});

test('长单会话压缩只发送有界事件窗口并保留当前上下文', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    for (let index = 0; index < 100; index += 1) await session.turn('查询服务状态');
    const before = await session.state();
    assert.ok(before.events.length > 128);
    const compacted = await session.compact();
    assert.equal(compacted.ok, true);
    const after = await session.state();
    assert.equal(after.context.integrity.criticalFieldHash, compacted.hashAfter);
    assert.equal(after.context.conversationTurns?.turns.length, before.context.conversationTurns?.turns.length);
  } finally { session.dispose(); }
});

/* 先生成旧工作流再重置，确保后续流式路由和取消使用新状态。
 * pending 标识、轮次计数和 done 事件共同验证状态及事件边界。
 * 重置前的对话使旧事件和工作流确实存在，避免空状态假阳性。
 * 重置后走流式入口创建待确认动作，读取宿主状态比较动作标识。
 * 随后调用普通确认入口取消，验证两个编排组件共享同一 pending。
 * turnCount 为 1 说明旧轮次未残留；pending 为空说明取消被投影。
 * done 仍是流式最后事件，确保组件化没有改变客户端终态协议。
 * finally 释放当前会话，不依赖测试执行顺序或缓存的资源。
 */
test('重置后流式路由和确认共享新工作流与新事件存储', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    await session.turn('列出今天的集成任务');
    await session.reset();
    const events: StreamEvent[] = [];
    const result = await session.turnStreamed('帮我创建工单', (event) => events.push(event));
    assert.equal(result.status, 'awaiting_confirmation');
    assert.equal((await session.state()).pending?.actionId, result.pending?.actionId);
    assert.equal((await session.confirm(false)).status, 'cancelled');
    const current = await session.state();
    assert.equal(current.stats.turnCount, 1);
    assert.equal(current.pending, null);
    assert.equal(events.at(-1)?.type, 'done');
  } finally { session.dispose(); }
});

test('普通与流式入口使用相同的连续路由恢复和确认边界', async () => {
  const normalSession = new IarSandboxSession({ mode: 'scripted' });
  const streamedSession = new IarSandboxSession({ mode: 'scripted' });
  try {
    const normalPending = await normalSession.turn('把订单接口的限流值调整到每秒50次');
    assert.equal(normalPending.status, 'awaiting_confirmation');
    if (normalPending.status !== 'awaiting_confirmation') return;
    assert.equal((await normalSession.confirm(true)).status, 'executed');
    const normal = await normalSession.turn('改成每秒200次吧');

    const streamedPending = await streamedSession.turn('把订单接口的限流值调整到每秒50次');
    assert.equal(streamedPending.status, 'awaiting_confirmation');
    if (streamedPending.status !== 'awaiting_confirmation') return;
    assert.equal((await streamedSession.confirm(true)).status, 'executed');
    const events: StreamEvent[] = [];
    const streamed = await streamedSession.turnStreamed('改成每秒200次吧', (event) => events.push(event));

    for (const result of [normal, streamed]) {
      assert.equal(result.status, 'awaiting_confirmation');
      assert.equal(result.replySource, 'none');
      assert.equal(result.route.functionId, 'api.gateway');
      assert.equal(result.route.pluginId, 'api-gateway-v1');
      assert.deepEqual(result.pending?.input, { operation: 'limit', query: '改成每秒200次吧', params: { receipt: 'gateway-limit-order-center', target: 'order-center' } });
    }
    assert.equal(streamed.status, normal.status);
    assert.equal(events.at(-1)?.type, 'done');
    const normalConfirmed = await normalSession.confirm(true);
    const streamedConfirmed = await streamedSession.confirm(true);
    assert.equal(normalConfirmed.status, 'executed');
    assert.equal(streamedConfirmed.status, 'executed');
    if (normalConfirmed.status !== 'executed' || streamedConfirmed.status !== 'executed') return;
    assert.equal(normalConfirmed.actionResult?.status, 'succeeded');
    assert.equal(streamedConfirmed.actionResult?.status, 'succeeded');
    assert.equal(normalConfirmed.actionResult?.output && typeof normalConfirmed.actionResult.output === 'object' && !Array.isArray(normalConfirmed.actionResult.output) ? normalConfirmed.actionResult.output.newLimit : undefined, '200/s');
    assert.equal(streamedConfirmed.actionResult?.output && typeof streamedConfirmed.actionResult.output === 'object' && !Array.isArray(streamedConfirmed.actionResult.output) ? streamedConfirmed.actionResult.output.newLimit : undefined, '200/s');
  } finally {
    normalSession.dispose();
    streamedSession.dispose();
  }
});

test('带取消语气的参数自我修正仍恢复原动作并重新确认', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const initial = await session.turn('把订单接口的限流值调整到每秒50次');
    assert.equal(initial.status, 'awaiting_confirmation');
    assert.equal((await session.confirm(true)).status, 'executed');
    const corrected = await session.turn('算了，改成每秒200次吧');
    assert.equal(corrected.status, 'awaiting_confirmation');
    assert.equal(corrected.route.functionId, 'api.gateway');
    if (corrected.status !== 'awaiting_confirmation') return;
    assert.deepEqual(corrected.pending.input, { operation: 'limit', query: '算了，改成每秒200次吧', params: { receipt: 'gateway-limit-order-center', target: 'order-center' } });
    const confirmed = await session.confirm(true);
    assert.equal(confirmed.status, 'executed');
    if (confirmed.status !== 'executed') return;
    assert.equal(confirmed.actionResult?.status, 'succeeded');
    assert.equal(confirmed.actionResult?.output && typeof confirmed.actionResult.output === 'object' && !Array.isArray(confirmed.actionResult.output) ? confirmed.actionResult.output.newLimit : undefined, '200/s');
  } finally { session.dispose(); }
});

test('Bridge pending 允许明确取消语句进入会话状态机', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const pending = await session.bridgeTurn('帮我创建一张工单，说咖啡机坏了');
    assert.equal(pending.status, 'awaiting_confirmation');
    const cancelled = await session.bridgeTurn('算了，不建了');
    assert.equal(cancelled.status, 'clarification');
    assert.equal(cancelled.reasonCode, 'workflow_cancelled');
    assert.equal((await session.state()).pending, null);
  } finally { session.dispose(); }
});

test('流式 Bridge pending 允许明确取消语句进入会话状态机', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const pending = await session.bridgeTurnStreamed('帮我创建一张工单，说投影仪坏了', () => undefined);
    assert.equal(pending.status, 'awaiting_confirmation');
    const cancelled = await session.bridgeTurnStreamed('算了，不建了', () => undefined);
    assert.equal(cancelled.status, 'clarification');
    assert.equal(cancelled.reasonCode, 'workflow_cancelled');
    assert.equal((await session.state()).pending, null);
  } finally { session.dispose(); }
});

test('限流增量续问恢复已验证目标并合成为新值', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const initial = await session.turn('把订单接口的限流调到每秒 100');
    assert.equal(initial.status, 'awaiting_confirmation');
    assert.equal((await session.confirm(true)).status, 'executed');

    const increment = await session.turn('再往上调 50');
    assert.equal(increment.status, 'awaiting_confirmation');
    assert.equal(increment.route.functionId, 'api.gateway');
    if (increment.status !== 'awaiting_confirmation') return;
    assert.deepEqual(increment.pending.input, {
      operation: 'limit',
      query: '再往上调 50',
      params: { receipt: 'gateway-limit-order-center', target: 'order-center', rate: '150/s' }
    });

    const confirmed = await session.confirm(true);
    assert.equal(confirmed.status, 'executed');
    if (confirmed.status !== 'executed') return;
    assert.equal(confirmed.actionResult?.status, 'succeeded');
    assert.equal(confirmed.actionResult?.output && typeof confirmed.actionResult.output === 'object' && !Array.isArray(confirmed.actionResult.output) ? confirmed.actionResult.output.newLimit : undefined, '150/s');

    const percentage = await session.turn('再提高 50%');
    assert.equal(percentage.status, 'awaiting_confirmation');
    if (percentage.status !== 'awaiting_confirmation') return;
    assert.equal((percentage.pending.input as { params?: { rate?: string } }).params?.rate, '225/s');
    const percentageConfirmed = await session.confirm(true);
    assert.equal(percentageConfirmed.status, 'executed');
    assert.equal(percentageConfirmed.actionResult?.output && typeof percentageConfirmed.actionResult.output === 'object' && !Array.isArray(percentageConfirmed.actionResult.output) ? percentageConfirmed.actionResult.output.newLimit : undefined, '225/s');
  } finally { session.dispose(); }
});

test('限流缺少明确目标时只收集参数，不创建待确认动作', async () => {
  const requests = [
    '把订单接口限流调一下',
    '把订单接口限流调低一点',
    '把限流调到 100 到 200 之间，你看着办',
    '把订单接口限流调高点，别低于100'
  ];
  for (const request of requests) {
    const session = new IarSandboxSession({ mode: 'scripted' });
    try {
      const result = await session.turn(request);
      assert.equal(result.status, 'clarification', request);
      assert.equal(result.reasonCode, 'parameters_required', request);
      assert.match(result.reply, /补充|限流|参数/u, request);
      assert.equal((await session.state()).pending, null, request);
    } finally { session.dispose(); }
  }
});

test('限流参数门禁覆盖 Function Calling 漏标动作类型的路径', () => {
  assert.equal(requiresGatewayRateClarification('把订单接口限流调低一点'), true);
  assert.equal(requiresGatewayRateClarification('把限流调到 100 到 200 之间，你看着办'), true);
  assert.equal(requiresGatewayRateClarification('把限流调到 1,000 次每秒'), false);
  assert.equal(requiresGatewayRateClarification('把限流调到一千二百'), false);
  assert.equal(requiresGatewayRateClarification('把订单接口限流调到每秒 150 次'), false);
  assert.equal(requiresGatewayRateClarification('再提高 50%'), false);
});

test('限流目标值支持千位分隔和小数值', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const grouped = await session.turn('把订单接口限流调到每秒1,000次');
    assert.equal(grouped.status, 'awaiting_confirmation');
    const groupedConfirmed = await session.confirm(true);
    assert.equal(groupedConfirmed.status, 'executed');
    if (groupedConfirmed.status === 'executed') {
      assert.equal((groupedConfirmed.actionResult?.output as { newLimit?: string } | undefined)?.newLimit, '1000/s');
    }

    const decimal = await session.turn('把订单接口限流调到每秒33.3次');
    assert.equal(decimal.status, 'awaiting_confirmation');
    const decimalConfirmed = await session.confirm(true);
    assert.equal(decimalConfirmed.status, 'executed');
    if (decimalConfirmed.status === 'executed') {
      assert.equal((decimalConfirmed.actionResult?.output as { newLimit?: string } | undefined)?.newLimit, '33.3/s');
    }
  } finally { session.dispose(); }
});

test('限流支持中文数字和分钟到秒的单位换算', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const chinese = await session.turn('把订单接口限流调到一千二百');
    assert.equal(chinese.status, 'awaiting_confirmation');
    const chineseConfirmed = await session.confirm(true);
    assert.equal(chineseConfirmed.status, 'executed');
    if (chineseConfirmed.status === 'executed') {
      assert.equal((chineseConfirmed.actionResult?.output as { newLimit?: string } | undefined)?.newLimit, '1200/s');
    }

    const perMinute = await session.turn('把订单接口限流调成每分钟 6000 次');
    assert.equal(perMinute.status, 'awaiting_confirmation');
    const perMinuteConfirmed = await session.confirm(true);
    assert.equal(perMinuteConfirmed.status, 'executed');
    if (perMinuteConfirmed.status === 'executed') {
      assert.equal((perMinuteConfirmed.actionResult?.output as { newLimit?: string } | undefined)?.newLimit, '100/s');
    }
  } finally { session.dispose(); }
});

test('取消权限申请后追问仍绑定已取消的申请', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const pending = await session.turn('帮我申请数据分析师角色权限');
    assert.equal(pending.status, 'awaiting_confirmation');
    assert.equal(pending.route.functionId, 'account.privilege');
    assert.equal((await session.confirm(false)).status, 'cancelled');

    const followUp = await session.turn('刚才那个申请，提交了吗？');
    assert.equal(followUp.status, 'clarification');
    assert.equal(followUp.disposition, 'context_answered');
    assert.match(followUp.reply, /取消|未提交/u);
    assert.doesNotMatch(followUp.reply, /订单接口|限流|gateway-limit/u);
  } finally { session.dispose(); }
});

test('普通与流式入口将已完成动作的事实追问统一视为上下文回答', async () => {
  const normalSession = new IarSandboxSession({ mode: 'scripted' });
  const streamedSession = new IarSandboxSession({ mode: 'scripted' });
  try {
    for (const session of [normalSession, streamedSession]) {
      const pending = await session.turn('帮我创建一张工单，描述是网络中断');
      assert.equal(pending.status, 'awaiting_confirmation');
      if (pending.status !== 'awaiting_confirmation') return;
      assert.equal((await session.confirm(true)).status, 'executed');
    }
    const normal = await normalSession.turn('刚才那张工单的编号是多少？');
    const events: StreamEvent[] = [];
    const streamed = await streamedSession.turnStreamed('刚才那张工单的编号是多少？', (event) => events.push(event));

    for (const result of [normal, streamed]) {
      assert.equal(result.status, 'clarification');
      assert.equal(result.disposition, 'context_answered');
      assert.equal(result.route.semanticIntent, 'unknown');
      assert.notEqual(result.route.reasonCode, 'workflow_transition_invalid');
      assert.notEqual(result.status, 'pass_through');
    }
    assert.deepEqual(
      { status: normal.status, reasonCode: normal.route.reasonCode, semanticIntent: normal.route.semanticIntent },
      { status: streamed.status, reasonCode: streamed.route.reasonCode, semanticIntent: streamed.route.semanticIntent }
    );
    assert.equal(events.at(-1)?.type, 'done');
  } finally {
    normalSession.dispose();
    streamedSession.dispose();
  }
});

test('已完成动作的状态追问仍使用可信事实上下文', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const pending = await session.turn('帮我创建一张工单，描述是网络中断');
    assert.equal(pending.status, 'awaiting_confirmation');
    if (pending.status !== 'awaiting_confirmation') return;
    assert.equal((await session.confirm(true)).status, 'executed');
    const result = await session.turn('这张工单现在处理到哪一步了？');
    assert.equal(result.status, 'clarification');
    assert.equal(result.disposition, 'context_answered');
    assert.equal(result.route.semanticIntent, 'unknown');
    assert.match(result.reply, /ticket|工单|created|created|分诊|受理/u);
    assert.notEqual(result.status, 'awaiting_confirmation');
    assert.notEqual(result.status, 'executed');
  } finally { session.dispose(); }
});

test('无对象泛查询不会吸附上一轮 Function', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const pending = await session.turn('帮我创建一张工单，描述是会议室投影仪连不上');
    assert.equal(pending.status, 'awaiting_confirmation');
    if (pending.status !== 'awaiting_confirmation') return;
    assert.equal((await session.confirm(true)).status, 'executed');

    const query = await session.turn('可以帮我查询下吧');
    assert.equal(query.status, 'clarification');
    assert.equal(query.route.functionId, undefined);
    assert.doesNotMatch(query.reply, /工单已创建|ticket-20261018/u);
    assert.match(query.reply, /查询|对象|补充/u);
  } finally { session.dispose(); }
});

test('明确新话题不会继承旧工单目标', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const pending = await session.turn('帮我创建一张工单，描述是会议室投影仪连不上');
    assert.equal(pending.status, 'awaiting_confirmation');
    if (pending.status !== 'awaiting_confirmation') return;
    assert.equal((await session.confirm(true)).status, 'executed');

    const limit = await session.turn('把订单接口限流调到每秒 200 次');
    assert.equal(limit.status, 'awaiting_confirmation');
    assert.equal(limit.route.functionId, 'api.gateway');
  } finally { session.dispose(); }
});

test('空会话的历史指代不会被业务名词误判为新动作', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const result = await session.turn('刚才那张工单的编号是多少？');
    assert.equal(result.status, 'clarification');
    assert.notEqual(result.status, 'awaiting_confirmation');
    assert.notEqual(result.status, 'executed');
    assert.equal((await session.state()).pending, null);
  } finally {
    session.dispose();
  }
});
