import assert from 'node:assert/strict';
import test from 'node:test';
import { callModelStream } from '../../../examples/agent-sandbox/src/models/model-stream-transport.js';
import { createBilingualLogWriter, formatBilingualLogLine } from '../../../examples/agent-sandbox/src/safe-log.js';
import { TurnTimingTracker } from '../../../examples/agent-sandbox/src/turn-timing.js';

test('计时追踪器记录总耗时、阶段耗时和首 token 耗时', () => {
  const values = [100, 115, 120, 145, 160, 190];
  const tracker = new TurnTimingTracker('trace-observability', () => values.shift() ?? 190);

  tracker.start('semantic.extract');
  tracker.end('semantic.extract');
  tracker.start('response.generate');
  tracker.firstToken('response.generate');
  tracker.end('response.generate');

  assert.deepEqual(tracker.finish(190), {
    traceId: 'trace-observability',
    durationMs: 90,
    stages: [
      { stage: 'semantic.extract', status: 'completed', durationMs: 5 },
      { stage: 'response.generate', status: 'completed', durationMs: 45, firstTokenMs: 15 }
    ]
  });
});

test('双语日志格式只展示受控摘要，不包含请求正文', () => {
  const line = formatBilingualLogLine({
    level: 'info',
    event: 'iar.turn.stage',
    traceId: 'trace-observability',
    stage: 'response.generate',
    status: 'completed',
    durationMs: 42,
    secretBody: '不要输出我'
  });

  assert.match(line, /阶段耗时 \/ Stage timing/);
  assert.match(line, /response\.generate/);
  assert.match(line, /status=completed/);
  assert.match(line, /42ms/);
  assert.doesNotMatch(line, /不要输出我/);
});

test('双语日志写入器将结构化 JSON 转成可读单行', async () => {
  let output = '';
  const writer = createBilingualLogWriter((buffer, done) => { output += buffer.toString('utf8'); done(null, buffer.length); });
  await new Promise<void>((resolve) => writer(Buffer.from('{"level":"info","event":"iar.turn.stage","stage":"route.select","durationMs":8}\n'), (error) => { assert.equal(error, null); resolve(); }));
  assert.match(output, /阶段耗时 \/ Stage timing/);
  assert.match(output, /route\.select/);
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
