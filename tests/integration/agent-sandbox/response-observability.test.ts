import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { callModelStream } from '../../../examples/agent-sandbox/src/models/model-stream-transport.js';
import { createBilingualLogWriter, createSafeLogSink, formatBilingualLogLine, logRouteContractFailure, logRouteDecision, logSemanticFrame } from '../../../examples/agent-sandbox/src/safe-log.js';
import { TurnTimingTracker } from '../../../examples/agent-sandbox/src/turn-timing.js';

test('计时追踪器记录总耗时、阶段耗时和首 token 耗时', () => {
  const values = [100, 115, 120, 125, 150, 155, 160, 190];
  const tracker = new TurnTimingTracker('trace-observability', () => values.shift() ?? 190);

  tracker.start('semantic.extract');
  tracker.end('semantic.extract');
  tracker.start('route.propose');
  tracker.end('route.propose');
  tracker.start('response.generate');
  tracker.firstToken('response.generate');
  tracker.end('response.generate');

  assert.deepEqual(tracker.finish(190), {
    traceId: 'trace-observability',
    durationMs: 90,
    stages: [
      { stage: 'semantic.extract', status: 'completed', durationMs: 5 },
      { stage: 'route.propose', status: 'completed', durationMs: 25 },
      { stage: 'response.generate', status: 'completed', durationMs: 35, firstTokenMs: 5 }
    ]
  });
});

test('双语日志格式只展示受控摘要，不包含请求正文', () => {
  const line = formatBilingualLogLine({
    level: 'info',
    event: 'iar.turn.stage',
    traceId: 'trace-observability',
    stage: 'response.generate',
    modelRole: 'response.generate',
    status: 'completed',
    durationMs: 42,
    secretBody: '不要输出我'
  });

  assert.match(line, /阶段耗时 \/ Stage timing/);
  assert.match(line, /response\.generate/);
  assert.match(line, /modelRole=response\.generate/);
  assert.match(line, /status=completed/);
  assert.match(line, /42ms/);
  assert.doesNotMatch(line, /不要输出我/);
});

test('语义抽取诊断输出字段状态、缺失原因和下一阶段，并保留双语标签', () => {
  const line = formatBilingualLogLine({
    level: 'warn',
    event: 'iar.semantic.frame',
    traceId: '123e4567-e89b-12d3-a456-426614174000',
    status: 'completed',
    semanticIntent: 'gateway.control',
    semanticAction: 'unknown',
    hasIntent: 'true',
    hasAction: 'false',
    missingField: 'action',
    nextStage: 'route.propose',
    rawUserText: '执行这个 200 次/秒',
  });

  assert.match(line, /语义抽取 \/ Semantic extraction/);
  assert.match(line, /semanticAction=unknown/);
  assert.match(line, /missingField=action/);
  assert.match(line, /nextStage=route\.propose/);
  assert.doesNotMatch(line, /执行这个 200 次\/秒/);
});

test('路由诊断区分抽取不完整、候选为空和执行阻断', () => {
  const line = formatBilingualLogLine({
    level: 'warn',
    event: 'iar.route.decision',
    traceId: '123e4567-e89b-12d3-a456-426614174000',
    stage: 'route.select',
    status: 'skipped',
    reasonCode: 'semantic_incomplete',
    nextStage: 'response.generate',
    candidateCount: 0,
    execution: 'blocked',
    modelRole: 'route.propose',
    rawModelResponse: '{"choice":"ticket.create"}',
  });

  assert.match(line, /路由决策 \/ Route decision/);
  assert.match(line, /reasonCode=semantic_incomplete/);
  assert.match(line, /candidateCount=0/);
  assert.match(line, /execution=blocked/);
  assert.doesNotMatch(line, /ticket\.create/);
});

test('语义与路由诊断入口写入同一安全 trace 并丢弃原文', async () => {
  let output = '';
  const restore = (await import('../../../examples/agent-sandbox/src/safe-log.js')).setSafeLogWriterForTesting((buffer, done) => { output += buffer.toString('utf8'); done(null, buffer.length); });
  try {
    logSemanticFrame('123e4567-e89b-12d3-a456-426614174000', {
      status: 'completed', semanticIntent: 'gateway.control', semanticAction: 'unknown', hasIntent: true, hasAction: false,
      missingField: 'action', nextStage: 'route.propose'
    });
    logRouteDecision('123e4567-e89b-12d3-a456-426614174000', Object.assign({
      stage: 'route.propose', status: 'skipped', reasonCode: 'semantic_incomplete', candidateCount: 0, execution: 'blocked', rawModelResponse: '不要写入日志'
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    restore();
  }
  const records = output.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(records.length, 2);
  assert.equal(records[0]?.event, 'iar.semantic.frame');
  assert.equal(records[1]?.event, 'iar.route.decision');
  assert.equal(records[0]?.traceId, records[1]?.traceId);
  assert.equal(records[1]?.candidateCount, 0);
  assert.equal(records[1]?.execution, 'blocked');
  assert.doesNotMatch(output, /不要写入日志/);
});

test('双语日志写入器将结构化 JSON 转成可读单行', async () => {
  let output = '';
  const writer = createBilingualLogWriter((buffer, done) => { output += buffer.toString('utf8'); done(null, buffer.length); });
  const sink = createSafeLogSink(writer, 2);
  sink.write({ level: 'info', event: 'iar.turn.stage', stage: 'route.select', durationMs: 8 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(output, /阶段耗时 \/ Stage timing/);
  assert.match(output, /route\.select/);
  assert.equal(output.trim().split('\n').length, 1);
});

test('路由契约失败输出固定双语诊断、expected/actual 和 traceId，不输出自由文本', async () => {
  let output = '';
  const restore = (await import('../../../examples/agent-sandbox/src/safe-log.js')).setSafeLogWriterForTesting((buffer, done) => { output += buffer.toString('utf8'); done(null, buffer.length); });
  try {
    logRouteContractFailure('123e4567-e89b-12d3-a456-426614174000', {
      reasonCode: 'operation_conflict', expectedOperation: 'limit', actualOperation: 'stats'
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    restore();
  }
  const formatted = formatBilingualLogLine(JSON.parse(output.trim()) as Record<string, unknown>);
  assert.match(formatted, /WARN 路由契约失败 \/ Route contract failure/);
  assert.match(formatted, /reasonCode=operation_conflict/);
  assert.match(formatted, /expectedOperation=limit/);
  assert.match(formatted, /actualOperation=stats/);
  assert.match(formatted, /traceId=/);
  assert.match(formatted, /操作信息冲突/);
  assert.match(formatted, /Operation information conflicts/);
  assert.doesNotMatch(formatted, /模型原始输出/);
});

test('日志模块先加载后仍能采用随后加载的 pretty 配置', () => {
  const safeLogPath = resolve(process.cwd(), 'dist/examples/agent-sandbox/src/safe-log.js');
  const script = [
    `const { writeSafeLog } = await import(${JSON.stringify(safeLogPath)});`,
    "process.env.IAR_LOG_FORMAT = 'pretty';",
    "writeSafeLog({ level: 'info', event: 'iar.turn.completed', traceId: '123e4567-e89b-12d3-a456-426614174000', durationMs: 12 });",
    'await new Promise((resolve) => setTimeout(resolve, 50));'
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, IAR_LOG_FORMAT: '' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /轮次完成 \/ Turn completed/);
  assert.doesNotMatch(result.stderr, /"event":"iar\.turn\.completed"/);
  assert.equal(result.stderr.trim().split('\n').length, 1);
});

test('模型 SSE 将 reasoning_content 和 content 分别交付', async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"先判断"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"最终答案"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

  try {
    const reasoning: string[] = [];
    const content: string[] = [];
    const result = await callModelStream({
      connection: { apiKey: 'test-key', baseUrl: 'http://model.test/v1', model: 'deepseek-test' },
      system: 'system',
      user: 'user',
      signal: new AbortController().signal
    }, (delta) => content.push(delta), (delta) => reasoning.push(delta));

    assert.equal(result, '最终答案');
    assert.deepEqual(reasoning, ['先判断']);
    assert.deepEqual(content, ['最终答案']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
