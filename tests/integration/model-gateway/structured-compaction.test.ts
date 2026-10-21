import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { type BehaviorContext } from '@iar/contracts';
import { createInitialContext } from '@iar/runtime';
import {
  ContextCompactorAdapter,
  ModelGateway,
  ModelProfileRegistry,
  type ModelProvider
} from '@iar/runtime';
import { buildCompactionUserPrompt } from '../../../examples/agent-sandbox/src/models/model-input-transport.js';
import { loadModelProfiles } from '@iar/runtime';

/**
 * 创建适配器测试使用的最小合法压缩结果。
 *
 * @param context - 测试使用的行为上下文
 * @returns 符合压缩结果协议的未验证对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
function compactionResult(context: BehaviorContext): Record<string, unknown> {
  return {
    schemaVersion: 'iar.compaction-result/v1',
    summary: '已保留结构化行为状态。',
    state: {
      subject: context.subject,
      intent: context.intent,
      action: context.action,
      route: context.route,
      slots: context.slots,
      workflow: context.workflow,
      pending: context.pending,
      confirmation: context.confirmation
    },
    references: [],
    preservedFacts: [],
    warnings: []
  };
}

test('compaction prompt excludes raw recent messages even when a caller supplies them', () => {
  const prompt = buildCompactionUserPrompt({
    behaviorContext: createInitialContext('run-compaction-prompt'),
    eventsToCompact: [],
    recentMessages: [{ role: 'user', text: '原始聊天机密内容' }]
  });
  assert.doesNotMatch(prompt, /原始聊天机密内容/);
  assert.doesNotMatch(prompt, /<recent_messages>/);
  assert.match(prompt, /结构化|事件|可信事实/);
});

test('context compactor adapter strips raw recent messages before provider invocation', async () => {
  const context = createInitialContext('run-compaction-adapter');
  let providerInput: Record<string, unknown> | undefined;
  const provider: ModelProvider = {
    complete: async (request) => {
      providerInput = request.input as Record<string, unknown>;
      return compactionResult(context);
    }
  };
  const profiles = loadModelProfiles(readFileSync(join(process.cwd(), 'config', 'models.yaml'), 'utf8'));
  const gateway = new ModelGateway({
    registry: new ModelProfileRegistry(profiles),
    providers: { mock: provider }
  });
  const result = await new ContextCompactorAdapter(gateway).compact({
    traceId: 'trace-compaction-adapter',
    runId: 'run-compaction-adapter',
    input: {
      behaviorContext: context,
      eventsToCompact: [],
      recentMessages: [{ role: 'user', text: '不应进入模型的原始消息' }]
    }
  });
  assert.equal(result.ok, true);
  assert.ok(providerInput);
  assert.equal(providerInput.recentMessages, undefined);
  assert.deepEqual(providerInput.behaviorContext, context);
});
