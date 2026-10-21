/** IAR 会话与进程内 Pi Agent 的协作测试。
 * 业务意图必须由 IAR 截获，普通闲聊交给 pi-agent-core 循环；
 * IAR 处理的轮次以备注进入 Pi 上下文，reset 双端清空。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SELF_INTRODUCTION_FUNCTION_ID } from '@iar/plugins';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';
import { FALLBACK_REPLY_TEXT } from '../../../examples/agent-sandbox/src/session-core.js';
import { createPiAgentDelegate, createSingleTextEvents, type PiAgentDelegate, type PiStreamFn } from '../../../examples/agent-sandbox/src/models/pi-agent-delegate.js';

/** 记录调用轨迹的假 Pi 委托。 */
function fakeDelegate(behavior?: { failRun?: boolean }) {
  const calls = { runs: [] as string[], recorded: [] as Array<[string, string]>, resets: 0 };
  const delegate: PiAgentDelegate = {
    run: async (text, onDelta) => {
      calls.runs.push(text);
      if (behavior?.failRun === true) throw new Error('pi agent down');
      onDelta('Pi 回复：');
      onDelta(text);
      return `Pi 回复：${text}`;
    },
    recordHandledTurn: (userText, reply) => { calls.recorded.push([userText, reply]); },
    reset: () => { calls.resets += 1; }
  };
  return { delegate, calls };
}

/** 收集 Pi 上下文并转发给真实 scripted 事件流的 streamFn 探针。 */
function contextProbe(replyText: string, seen: unknown[][]): PiStreamFn {
  return ((model: unknown, context: unknown, options: unknown) => {
    seen.push([model, context, options]);
    return createSingleTextEvents(replyText);
  }) as PiStreamFn;
}

test('业务意图由 IAR 截获执行，Pi 委托不被调用但收到上下文备注', async () => {
  const { delegate, calls } = fakeDelegate();
  const session = new IarSandboxSession({ mode: 'scripted', piAgent: delegate });
  try {
    const result = await session.turn('现在有哪些告警');
    assert.equal(result.status, 'executed');
    assert.deepEqual(calls.runs, []);
    assert.equal(calls.recorded.length, 1);
    assert.equal(calls.recorded[0]?.[0], '现在有哪些告警');
    assert.ok((calls.recorded[0]?.[1] ?? '').length > 0);
  } finally {
    session.dispose();
  }
});

test('普通闲聊进入 Pi 循环并返回 agent 状态，不重复写入上下文', async () => {
  const { delegate, calls } = fakeDelegate();
  const session = new IarSandboxSession({ mode: 'scripted', piAgent: delegate });
  try {
    const result = await session.turn('你好');
    assert.equal(result.status, 'agent');
    assert.equal(result.reply, 'Pi 回复：你好');
    assert.deepEqual(calls.runs, ['你好']);
    assert.deepEqual(calls.recorded, []);
  } finally {
    session.dispose();
  }
});

test('流式闲聊透传 Pi 增量并以 agent 终态结束', async () => {
  const { delegate, calls } = fakeDelegate();
  const session = new IarSandboxSession({ mode: 'scripted', piAgent: delegate });
  try {
    const events: Array<{ type: string; text?: string; stage?: string }> = [];
    const result = await session.turnStreamed('讲个笑话', (event) => { events.push(event as { type: string }); });
    assert.equal(result.status, 'agent');
    assert.equal(result.reply, 'Pi 回复：讲个笑话');
    const deltas = events.filter((event) => event.type === 'delta').map((event) => (event as { text: string }).text);
    assert.deepEqual(deltas, ['Pi 回复：', '讲个笑话']);
    assert.equal(events.at(-1)?.type, 'done');
  } finally {
    session.dispose();
  }
});

test('没有 Pi 委托时会话保持原有兜底行为', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const result = await session.turn('你好');
    assert.equal(result.status, 'clarification');
    assert.equal(result.reply, FALLBACK_REPLY_TEXT);
  } finally {
    session.dispose();
  }
});

test('reset 同时清空 IAR 会话与 Pi 委托', async () => {
  const { delegate, calls } = fakeDelegate();
  const session = new IarSandboxSession({ mode: 'scripted', piAgent: delegate });
  try {
    await session.turn('你好');
    await session.reset();
    assert.equal(calls.resets, 1);
  } finally {
    session.dispose();
  }
});

test('确认执行轮以备注形式进入 Pi 上下文', async () => {
  const { delegate, calls } = fakeDelegate();
  const session = new IarSandboxSession({ mode: 'scripted', piAgent: delegate });
  try {
    const pending = await session.turn('帮我提个工单，网络很卡');
    assert.equal(pending.status, 'awaiting_confirmation');
    const confirmed = await session.confirm(true);
    assert.equal(confirmed.status, 'executed');
    assert.ok(calls.recorded.some(([userText]) => userText === '（确认执行）'));
  } finally {
    session.dispose();
  }
});

test('Pi 委托故障时回退 IAR 兜底回复，会话不中断', async () => {
  const { delegate, calls } = fakeDelegate({ failRun: true });
  const session = new IarSandboxSession({ mode: 'scripted', piAgent: delegate });
  try {
    const result = await session.turn('你好');
    assert.equal(result.status, 'clarification');
    assert.equal(result.reply, FALLBACK_REPLY_TEXT);
    assert.deepEqual(calls.runs, ['你好']);
    const followUp = await session.turn('现在有哪些告警');
    assert.equal(followUp.status, 'executed');
  } finally {
    session.dispose();
  }
});

test('真实 Pi 循环处理普通闲聊：注入 streamFn 探针证明 Agent 循环真实运转', async () => {
  const seen: unknown[][] = [];
  const delegate = createPiAgentDelegate({ mode: 'scripted', sessionId: 'pi-demo', streamFn: contextProbe('探针回复', seen) });
  const session = new IarSandboxSession({ mode: 'scripted', piAgent: delegate });
  try {
    const result = await session.turnStreamed('讲个笑话', () => undefined);
    assert.equal(result.status, 'agent');
    assert.equal(result.reply, '探针回复');
    assert.ok(seen.length >= 1);
  } finally {
    session.dispose();
  }
});

test('自我介绍意图由内置 Plugin 执行，不再交给 Pi 循环', async () => {
  const delegate = createPiAgentDelegate({ mode: 'scripted', sessionId: 'pi-demo-1' });
  const session = new IarSandboxSession({ mode: 'scripted', piAgent: delegate });
  try {
    const result = await session.turn('你是谁呢');
    assert.equal(result.status, 'executed');
    if (result.status !== 'executed') return;
    assert.equal(result.route.functionId, SELF_INTRODUCTION_FUNCTION_ID);
    assert.ok(result.reply.includes('我是 IAR Agent'));
    assert.ok(result.reply.includes('当前可用能力'));
  } finally {
    session.dispose();
  }
});

test('真实 Pi 循环默认 scripted 回复：未知输入回退固定话术', async () => {
  const delegate = createPiAgentDelegate({ mode: 'scripted', sessionId: 'pi-demo-2' });
  const session = new IarSandboxSession({ mode: 'scripted', piAgent: delegate });
  try {
    const result = await session.turn('你好');
    assert.equal(result.status, 'agent');
    assert.equal(result.reply, FALLBACK_REPLY_TEXT);
  } finally {
    session.dispose();
  }
});

test('IAR 处理轮次进入 Pi 上下文，后续 Pi 轮可见历史', async () => {
  const seen: unknown[][] = [];
  const delegate = createPiAgentDelegate({ mode: 'scripted', sessionId: 'pi-demo-3', streamFn: contextProbe('好的', seen) });
  const session = new IarSandboxSession({ mode: 'scripted', piAgent: delegate });
  try {
    await session.turn('现在有哪些告警');
    await session.turn('你好');
    const lastContext = seen.at(-1)?.[1] as { messages: Array<{ role: string; content: string }> };
    assert.ok(lastContext.messages.some((message) => message.role === 'user' && message.content.includes('已由业务系统处理')));
  } finally {
    session.dispose();
  }
});

test('Pi 委托 reset 后不再携带旧上下文', async () => {
  const seen: unknown[][] = [];
  const delegate = createPiAgentDelegate({ mode: 'scripted', sessionId: 'pi-demo-4', streamFn: contextProbe('好的', seen) });
  const session = new IarSandboxSession({ mode: 'scripted', piAgent: delegate });
  try {
    await session.turn('你好');
    seen.length = 0;
    await session.reset();
    await session.turn('你好');
    const lastContext = seen.at(-1)?.[1] as { messages: Array<{ role: string; content: string }> };
    assert.ok(!lastContext.messages.some((message) => message.content.includes('Pi 回复') || message.content.includes('已由业务系统处理')));
  } finally {
    session.dispose();
  }
});
