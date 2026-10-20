import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySnapshotStore } from '@iar/storage';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';

test('第一次无法路由只增加 unresolved streak，不执行插件', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const result = await session.turn('这是一条无法判断用途的输入');
    const state = await session.state();
    assert.equal(result.status, 'clarification');
    assert.equal(state.context.clarification?.mode, 'unresolved');
    assert.equal(state.context.clarification?.unresolvedStreak, 1);
    assert.equal(state.context.pending.options, undefined);
    assert.equal(state.events.some((event) => event.eventName === 'action.started'), false);
  } finally {
    session.dispose();
  }
});

test('连续无法路由达到阈值后生成当前 Plugin 描述对应的动态选项', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    await session.turn('这是一条无法判断用途的输入');
    const result = await session.turn('蓝色的云朵正在窗外发光');
    const state = await session.state();
    assert.equal(result.status, 'clarification');
    assert.equal(state.context.clarification?.mode, 'selection');
    assert.equal(state.context.clarification?.unresolvedStreak, 2);
    assert.ok((state.context.clarification?.candidateKeys?.length ?? 0) > 0);
    assert.deepEqual(state.context.pending.options, state.context.clarification?.candidateKeys?.map((key) => ({ key, label: assertOptionLabel(state.context.pending.options, key) })));
    assert.equal(state.events.some((event) => event.eventName === 'action.started'), false);
  } finally {
    session.dispose();
  }
});

test('没有可用 Plugin 候选时保持 unresolved，不生成空选择', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const host = (session as unknown as { pluginHost: { descriptors: () => Array<{ pluginId: string }>; disable: (pluginId: string) => unknown } }).pluginHost;
    for (const descriptor of host.descriptors()) host.disable(descriptor.pluginId);
    await session.turn('这是一条无法判断用途的输入');
    await session.turn('蓝色的云朵正在窗外发光');
    const state = await session.state();
    assert.equal(state.context.clarification?.mode, 'unresolved');
    assert.equal(state.context.clarification?.unresolvedStreak, 2);
    assert.equal(state.context.pending.options, undefined);
  } finally {
    session.dispose();
  }
});

test('成功进入确认或执行路径后会清零 unresolved streak', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    await session.turn('这是一条无法判断用途的输入');
    const result = await session.turn('帮我创建工单，网络很慢');
    const state = await session.state();
    assert.equal(result.status, 'awaiting_confirmation');
    assert.equal(state.context.clarification?.mode, 'none');
    assert.equal(state.context.clarification?.unresolvedStreak, 0);
  } finally {
    session.dispose();
  }
});

test('等待确认期间不会增加 unresolved streak', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const result = await session.turn('帮我创建工单，网络很慢');
    assert.equal(result.status, 'awaiting_confirmation');
    const before = await session.state();
    assert.equal(before.context.clarification?.unresolvedStreak ?? 0, 0);
    assert.ok(before.pending);
  } finally {
    session.dispose();
  }
});

test('历史关系无法解析时不会误答当前记录，并按次数进入动态选择兜底', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    assert.equal((await session.turn('帮我创建工单，网络很慢')).status, 'awaiting_confirmation');
    assert.equal((await session.confirm(true)).status, 'executed');

    const first = await session.turn('告诉我上一个工单编号');
    assert.equal(first.status, 'clarification');
    assert.equal((await session.state()).context.clarification?.unresolvedStreak, 1);
    assert.doesNotMatch(first.reply, /ticket-20261018/);

    const second = await session.turn('还是告诉我上一个工单编号');
    const state = await session.state();
    assert.equal(second.status, 'clarification');
    assert.equal(state.context.clarification?.mode, 'selection');
    assert.ok((state.context.pending.options?.length ?? 0) > 0);
    assert.doesNotMatch(second.reply, /ticket-20261018/);
  } finally {
    session.dispose();
  }
});

test('有效动态候选重新进入正常路由和执行门禁', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    await session.turn('这是一条无法判断用途的输入');
    await session.turn('蓝色的云朵正在窗外发光');
    const before = await session.state();
    const key = before.context.clarification?.candidateKeys?.[0];
    assert.ok(key);
    const result = await session.turn(key);
    assert.notEqual(result.status, 'failed');
    assert.equal((await session.state()).context.clarification?.mode, 'none');
    assert.equal((await session.state()).events.some((event) => event.eventName === 'action.started'), true);
  } finally {
    session.dispose();
  }
});

test('候选在等待期间失效时拒绝选择且不执行插件', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    await session.turn('这是一条无法判断用途的输入');
    await session.turn('蓝色的云朵正在窗外发光');
    const before = await session.state();
    const key = before.context.clarification?.candidateKeys?.[0];
    assert.ok(key);
    const host = (session as unknown as { pluginHost: { descriptors: () => Array<{ candidateKey: string; pluginId: string }>; disable: (pluginId: string) => unknown } }).pluginHost;
    const descriptor = host.descriptors().find((item) => item.candidateKey === key);
    assert.ok(descriptor);
    host.disable(descriptor.pluginId);
    const result = await session.turn(key);
    const after = await session.state();
    assert.equal(result.status, 'clarification');
    assert.equal(after.events.some((event) => event.eventName === 'action.started'), false);
  } finally {
    session.dispose();
  }
});

test('流式入口与普通入口共享动态选择和 unresolved 状态机', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const events: unknown[] = [];
    assert.equal((await session.turnStreamed('这是一条无法判断用途的输入', (event) => events.push(event))).status, 'clarification');
    const second = await session.turnStreamed('另一条仍然无法判断用途的输入', (event) => events.push(event));
    assert.equal(second.status, 'clarification');
    const state = await session.state();
    const key = state.context.clarification?.candidateKeys?.[0];
    assert.ok(key);
    const selected = await session.turnStreamed(key, (event) => events.push(event));
    assert.notEqual(selected.status, 'failed');
    assert.equal((await session.state()).context.clarification?.mode, 'none');
    assert.ok(events.some((event) => typeof event === 'object' && event !== null && 'type' in event && (event as { type?: string }).type === 'done'));
  } finally {
    session.dispose();
  }
});

test('重启后仍可从快照恢复动态选择并校验候选', async () => {
  const snapshotStore = new InMemorySnapshotStore();
  const first = new IarSandboxSession({ mode: 'scripted', sessionId: 'selection-restart', snapshotStore });
  let firstDisposed = false;
  try {
    await first.turn('这是一条无法判断用途的输入');
    await first.turn('蓝色的云朵正在窗外发光');
    await first.flushPersistence();
    const before = await first.state();
    const key = before.context.clarification?.candidateKeys?.[0];
    assert.ok(key);
    first.dispose();
    firstDisposed = true;
    const restored = new IarSandboxSession({ mode: 'scripted', sessionId: 'selection-restart', snapshotStore });
    try {
      await restored.whenReady();
      const recovered = await restored.state();
      assert.equal(recovered.context.clarification?.mode, 'selection');
      assert.deepEqual(recovered.context.pending.options?.map((option) => option.key), recovered.context.clarification?.candidateKeys);
      assert.notEqual((await restored.turn(key)).status, 'failed');
    } finally {
      restored.dispose();
    }
  } finally {
    if (!firstDisposed) first.dispose();
  }
});

function assertOptionLabel(options: Array<{ key: string; label: string }> | undefined, key: string): string {
  const label = options?.find((option) => option.key === key)?.label;
  assert.ok(label);
  return label;
}
