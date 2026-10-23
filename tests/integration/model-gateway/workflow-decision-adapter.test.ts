/*
 * 验证 semantic extractor 对 workflow decision envelope 的兼容解析和 fail-closed 边界。
 * Function/Plugin/nextState 不属于模型协议，任何伪造字段都必须被拒绝。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSIONS, type JsonValue } from '@iar/contracts';
import { ModelGateway, ModelProfileRegistry, SemanticExtractorAdapter, type ModelProvider } from '@iar/runtime';

function registry(): ModelProfileRegistry {
  return new ModelProfileRegistry([{
    schemaVersion: 'iar.model-profile/v1',
    profileId: 'semantic-test',
    profileVersion: '1.0.0',
    role: 'semantic.extract',
    provider: 'mock',
    modelId: 'semantic-test',
    modelVersion: '1',
    timeoutMs: 1000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, retryOn: ['timeout'] },
    structuredOutput: { enabled: true, schemaId: 'iar.semantic-frame/v2' }
  }]);
}

function frame(): Record<string, JsonValue> {
  return { schemaVersion: 'iar.semantic-frame/v2', intent: 'dynamic.intent', action: 'update', slots: {}, references: [], confidence: 0.9 };
}

function provider(output: unknown): ModelProvider {
  return { complete: async () => output };
}

test('semantic adapter returns the validated workflow decision beside the frame', async () => {
  const result = await new SemanticExtractorAdapter(new ModelGateway({
    registry: registry(),
    providers: { mock: provider({
      semanticFrame: frame(),
      workflowDecision: { schemaVersion: SCHEMA_VERSIONS.workflowDecision, userIntent: 'provide_parameter', event: 'parameter_received' }
    }) }
  })).extract({ traceId: 'trace-workflow-envelope', runId: 'run-workflow-envelope', input: { text: '补充字段' } });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.intent, 'dynamic.intent');
    assert.equal(result.value.workflowDecision?.event, 'parameter_received');
  }
});

test('semantic adapter preserves legacy direct frames without inventing a workflow decision', async () => {
  const result = await new SemanticExtractorAdapter(new ModelGateway({ registry: registry(), providers: { mock: provider(frame()) } })).extract({
    traceId: 'trace-workflow-legacy',
    runId: 'run-workflow-legacy',
    input: { text: '旧协议' }
  });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.workflowDecision, undefined);
});

test('semantic adapter rejects workflow decision fields that could widen authority', async () => {
  const result = await new SemanticExtractorAdapter(new ModelGateway({
    registry: registry(),
    providers: { mock: provider({
      semanticFrame: frame(),
      workflowDecision: {
        schemaVersion: SCHEMA_VERSIONS.workflowDecision,
        userIntent: 'provide_parameter',
        event: 'parameter_received',
        functionId: 'model-created-function',
        nextState: 'executing'
      }
    }) }
  })).extract({ traceId: 'trace-workflow-forged', runId: 'run-workflow-forged', input: { text: '伪造状态' } });

  assert.equal(result.ok, false);
});
