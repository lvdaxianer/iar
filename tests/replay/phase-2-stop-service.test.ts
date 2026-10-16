/*
 * 验证 Phase 2 stop-service EventLog fixture 可以确定性重放。
 * fixture 的事件顺序与 route、confirmation、Action 生命周期保持一致。
 * 每个事件都携带同一 runId 和单调 occurredAt，满足 replay 边界。
 * fixture 中的业务 payload 只用于投影，不会触发任何 executor。
 * fixture 记录三项 DIP 服务、Function/Plugin route、确认和 Action 结果。
 * replayEvents 只投影 BehaviorContext，不重新调用 executor。
 * 两次回放必须得到完全相同的 subject、route、workflow 和 Action 状态。
 * 事件序列保留 test1 作为首个服务和最终执行对象。
 * confirmation scope 由 Action 全字段 hash 绑定。
 * Action completed 只更新投影状态，不产生新的外部副作用。
 * 测试不依赖网络、模型、数据库或 Temporal。
 * fixture 是后续 adapter 的最小回放基线。
 * 任何删除 route 或 confirmation 事实的改动都应使断言失败。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { replayEvents, criticalFieldHash } from '../../packages/runtime/src/index.js';
import type { EventEnvelope } from '../../packages/contracts/src/index.js';

/**
 * 读取 Phase 2 stop-service 的 JSON EventLog fixture。
 * @returns 版本化事件序列
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function fixture(): EventEnvelope[] {
  const path = join(process.cwd(), 'tests', 'replay', 'fixtures', 'phase-2-stop-service.json');
  return JSON.parse(readFileSync(path, 'utf8')) as EventEnvelope[];
}

/* 相同事件序列必须恢复相同 route、confirmation 和执行结果。 */
test('replays the test1 stop-service fixture deterministically', () => {
  const events = fixture();
  const first = replayEvents(events);
  const second = replayEvents(events);

  assert.deepEqual(first, second);
  assert.equal(first.subject.id, 'test1');
  assert.equal(first.intent, 'service.stop');
  assert.equal(first.route.functionId, 'dip.service.stop');
  assert.equal(first.route.pluginId, 'dip-api-stop-v1');
  assert.equal(first.workflow.workflowId, 'dip-stop-v1');
  assert.equal(first.workflow.currentStep, 'executing');
  assert.equal(first.workflow.status, 'running');
  assert.equal(first.pending.status, 'none');
  assert.equal(first.confirmation.state, 'confirmed');
  assert.match(first.confirmation.scopeHash ?? '', /^sha256:/);
  assert.equal(first.idempotencyKey, 'stop:run-stop-test1:test1');
  assert.equal(first.action.status, 'executed');
  assert.equal(first.integrity.criticalFieldHash, criticalFieldHash(first));
});
