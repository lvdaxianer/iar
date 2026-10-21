/** 验证沙箱通过真实自我介绍 Plugin 完成意图、执行和模型回复。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSIONS, type ActionDefinition, type ActionResult } from '@iar/contracts';
import { SELF_INTRODUCTION_FUNCTION_ID, SELF_INTRODUCTION_PLUGIN_ID } from '@iar/plugins';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';

/** 构造不涉及真实执行的回复测试动作。 */
function replyAction(): ActionDefinition {
  return { schemaVersion: SCHEMA_VERSIONS.action, actionId: 'action-reply-test', runId: 'sandbox-session', functionId: 'test.function', pluginId: 'test-plugin', idempotencyKey: 'idem-reply-test', input: {}, riskLevel: 'low', confirmationRequired: false };
}

test('self-introduction intent executes the built-in Plugin and uses scoped configuration', async () => {
  const session = new IarSandboxSession({
    mode: 'scripted',
    disabledPluginIds: ['knowledge-query-v1'],
    selfIntroduction: { extraPrompt: '先说结论，再列能力' }
  });

  const result = await session.turn('hi');

  assert.equal(result.status, 'executed');
  if (result.status !== 'executed') return;
  assert.equal(result.route.functionId, SELF_INTRODUCTION_FUNCTION_ID);
  assert.match(result.reply, /先说结论，再列能力/);
  assert.match(result.reply, /数据集成管理/);
  assert.doesNotMatch(result.reply, /平台使用 FAQ/);
  session.dispose();
});

test('self-introduction Plugin is enabled by default but can be disabled at Agent creation', async () => {
  const enabled = new IarSandboxSession({ mode: 'scripted' });
  try {
    const enabledResult = await enabled.turn('介绍下自己呢');
    assert.equal(enabledResult.status, 'executed');
    if (enabledResult.status === 'executed') assert.equal(enabledResult.route.functionId, SELF_INTRODUCTION_FUNCTION_ID);

    const disabled = new IarSandboxSession({ mode: 'scripted', disabledPluginIds: [SELF_INTRODUCTION_PLUGIN_ID] });
    try {
      const disabledResult = await disabled.turn('介绍下自己呢');
      assert.notEqual(disabledResult.status, 'executed');
      assert.notEqual(disabledResult.route?.functionId, SELF_INTRODUCTION_FUNCTION_ID);
      const descriptors = (disabled as unknown as { pluginHost: { descriptors: () => Array<{ functionId: string }> } }).pluginHost.descriptors();
      assert.equal(descriptors.some((descriptor) => descriptor.functionId === SELF_INTRODUCTION_FUNCTION_ID), false);
    } finally {
      disabled.dispose();
    }
  } finally {
    enabled.dispose();
  }
});

test('Function direct/none 响应在回复层分流且不调用回复模型', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const replies = (session as unknown as { replies: { generateReply: (context: unknown) => Promise<string>; generateReplyStreamed: (context: unknown, onDelta: (delta: string) => void) => Promise<string> } }).replies;
    const context = (await session.state()).context;
    const action = replyAction();
    const directResult: ActionResult = { schemaVersion: SCHEMA_VERSIONS.action, actionId: action.actionId, status: 'succeeded', output: { accepted: true }, response: { schemaVersion: 'iar.function-response/v1', mode: 'direct', text: '已将限流调整为 50 次' } };
    const noneResult: ActionResult = { schemaVersion: SCHEMA_VERSIONS.action, actionId: action.actionId, status: 'succeeded', output: { accepted: true }, response: { schemaVersion: 'iar.function-response/v1', mode: 'none', ui: { kind: 'confirmation' } } };
    const base = { traceId: 'trace-reply-test', runId: action.runId, userText: '执行动作', behaviorContext: context, recentMessages: [], functionDescriptors: [], action };
    assert.equal(await replies.generateReply({ ...base, actionResult: directResult }), '已将限流调整为 50 次');
    const deltas: string[] = [];
    assert.equal(await replies.generateReplyStreamed({ ...base, actionResult: directResult }, (delta) => deltas.push(delta)), '已将限流调整为 50 次');
    assert.deepEqual(deltas, ['已将限流调整为 50 次']);
    assert.equal(await replies.generateReply({ ...base, actionResult: noneResult }), '');
    assert.equal(await replies.generateReplyStreamed({ ...base, actionResult: noneResult }, () => { throw new Error('none 不应产生聊天增量'); }), '');
  } finally {
    session.dispose();
  }
});
