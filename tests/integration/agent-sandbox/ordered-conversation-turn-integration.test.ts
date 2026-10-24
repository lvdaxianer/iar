/** 验证会话公开入口在最终回复边界创建有序会话轮次。
 * 普通、流式、澄清、失败和确认路径都只能形成完整的用户输入/助手回复对。
 * 流式超限等没有提交完整回复的路径不能把部分增量写成会话轮次。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ScriptedModelProvider } from '../../../examples/agent-sandbox/src/models/scripted-provider.js';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';
import type { ConversationTurn } from '@iar/contracts';

test('普通、流式和澄清回复都形成单一有序会话轮次', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const normal = await session.turn('列出今天的集成任务');
    const events: Array<{ type: string }> = [];
    const streamed = await session.turnStreamed('完全不在能力范围的闲聊内容', (event) => events.push(event));
    assert.equal(normal.status, 'executed');
    assert.equal(streamed.status, 'clarification');
    const state = await session.state();
    const turns = state.context.conversationTurns?.turns ?? [];
    assert.deepEqual(turns.map((turn) => turn.sequence), [1, 2]);
    assert.deepEqual(turns.map((turn) => turn.userText), ['列出今天的集成任务', '完全不在能力范围的闲聊内容']);
    assert.equal(turns[0]?.assistantText, normal.reply);
    assert.equal(turns[1]?.assistantText, streamed.reply);
    assert.equal(state.events.filter((event) => event.eventName === 'conversation.turn.completed').length, 2);
    assert.equal(events.at(-1)?.type, 'done');
  } finally {
    session.dispose();
  }
});

test('待确认与确认取消分别记录各自的完整用户输入和助手回复', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const pending = await session.turn('帮我创建工单');
    const cancelled = await session.confirm(false);
    assert.equal(pending.status, 'awaiting_confirmation');
    assert.equal(cancelled.status, 'cancelled');
    const state = await session.state();
    const turns = state.context.conversationTurns?.turns ?? [];
    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.outcome, 'awaiting_confirmation');
    assert.equal(turns[1]?.outcome, 'cancelled');
    assert.equal(turns[1]?.userText, '（取消操作）');
    assert.equal(turns[1]?.assistantText, cancelled.reply);
  } finally {
    session.dispose();
  }
});

test('语义失败仍记录完整失败回复，但未完成模型回复不形成轮次', async () => {
  const originalComplete = ScriptedModelProvider.prototype.complete;
  ScriptedModelProvider.prototype.complete = async function malformedSemantic(request) {
    if (request.profile.role === 'semantic.extract') return { malformed: true };
    return originalComplete.call(this, request);
  };
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const result = await session.turn('测试失败输入');
    assert.equal(result.status, 'failed');
    const state = await session.state();
    const turns = state.context.conversationTurns?.turns ?? [];
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.outcome, 'failed');
    assert.equal(turns[0]?.assistantText, result.reply);
  } finally {
    session.dispose();
    ScriptedModelProvider.prototype.complete = originalComplete;
  }
});

test('轮次对象只保存边界允许的字段', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    await session.turn('查询服务状态');
    const state = await session.state();
    const turn = state.context.conversationTurns?.turns[0] as ConversationTurn;
    assert.deepEqual(Object.keys(turn).sort(), ['actionTaken', 'assistantText', 'completedAt', 'outcome', 'sequence', 'turnId', 'userText'].sort());
  } finally {
    session.dispose();
  }
});
