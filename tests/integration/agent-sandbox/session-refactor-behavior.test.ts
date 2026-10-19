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
import type { StreamEvent } from '../../../examples/agent-sandbox/src/session.js';

/* 同一脚本输入走两个公开入口，比较执行终态。
 * 流式阶段及 done 的顺序是客户端可观察协议，重构不能改变。
 * scripted 模式让结果不依赖外部模型网络或不确定的生成内容。
 * 普通入口和流式入口都必须报告动作已执行，避免路由实现分叉。
 * 阶段顺序覆盖语义、路由、动作和回复四个调用边界。
 * done 必须是最后一个事件，且承载的结果与返回值完全一致。
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
