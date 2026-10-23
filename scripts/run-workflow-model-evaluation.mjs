/**
 * 显式运行工作流语义模型实验；默认不访问外部模型。
 *
 * 使用方式：npm run eval:workflow-model -- --real-model
 * 输出只包含有界阶段指标，不输出 prompt、模型回复、参数值或凭据。
 */
import { loadDotEnv } from '../dist/examples/agent-sandbox/src/env.js';

const REAL_MODEL_FLAG = '--real-model';
const REPORT_SCHEMA = 'iar.workflow-model-evaluation/v1';

try {
  loadDotEnv();
} catch {
  writeReport({ status: 'failed', reasonCode: 'env_load_failed', message: '实验配置读取失败；未启动模型调用。' });
  process.exit(1);
}

if (!process.argv.includes(REAL_MODEL_FLAG)) {
  writeReport({ status: 'skipped', reasonCode: 'explicit_opt_in_required', message: '未执行真实模型实验；请显式传入 --real-model。' });
  process.exit(0);
}

if (!hasConfiguredCredential()) {
  writeReport({ status: 'skipped', reasonCode: 'model_credentials_missing', message: '未执行真实模型实验；缺少 IAR_LLM_API_KEY 或 IAR_MODEL_API_KEY。' });
  process.exit(0);
}

try {
  const [{ createSandboxModels }, { SemanticExtractorAdapter }, { evaluateWorkflowFrame }, { buildWorkflowEvaluationReport }, { WORKFLOW_EVALUATION_SCENARIOS }] = await Promise.all([
    import('../dist/examples/agent-sandbox/src/session-dependencies.js'),
    import('@iar/runtime'),
    import('../dist/tests/integration/model-gateway/workflow-evaluation-oracle.js'),
    import('../dist/tests/integration/model-gateway/workflow-evaluation-report.js'),
    import('../dist/tests/integration/model-gateway/workflow-evaluation-fixtures.js')
  ]);
  const models = createSandboxModels({ mode: 'brain' });
  const extractor = new SemanticExtractorAdapter(models.gateway);
  const observations = [];
  let modelFailures = 0;
  for (const scenario of WORKFLOW_EVALUATION_SCENARIOS) {
    const extracted = await extractor.extract({
      traceId: `workflow-eval-${scenario.id}`,
      runId: 'workflow-model-evaluation',
      input: {
        text: scenario.userText,
        behaviorContext: scenario.behaviorContext,
        recentMessages: scenario.recentMessages,
        pluginDescriptors: scenario.pluginDescriptors,
        ...(scenario.pendingAction === undefined ? {} : { pendingAction: scenario.pendingAction }),
        ...(scenario.structuredInput === undefined ? {} : { structuredInput: scenario.structuredInput })
      }
    });
    const actual = extracted.ok
      ? evaluateWorkflowFrame({ frame: extracted.value, behaviorContext: scenario.behaviorContext, authorizedFunctions: syntheticFunctions() })
      : modelFailureOutcome(extracted.error.code);
    if (!extracted.ok) modelFailures += 1;
    observations.push({ scenarioId: scenario.id, expected: scenario.expected, actual });
  }
  const report = buildWorkflowEvaluationReport(observations);
  const routeCases = observations.filter((item) => item.expected.functionId !== undefined || item.expected.pluginId !== undefined);
  const routeMatches = routeCases.filter((item) => item.expected.functionId === item.actual.functionId && item.expected.pluginId === item.actual.pluginId).length;
  const securityViolations = observations.filter((item) => item.actual.execute && !isAuthorizedRoute(item.actual.functionId, item.actual.pluginId)).length;
  writeReport({
    schemaVersion: REPORT_SCHEMA,
    status: 'completed',
    metrics: {
      scenarioCount: report.summary.total,
      transitionAccuracy: ratio(report.summary.passed, report.summary.total),
      routeAccuracy: ratio(routeMatches, routeCases.length),
      modelFailures,
      securityViolations
    },
    report
  });
} catch {
  writeReport({ status: 'failed', reasonCode: 'runner_failed', message: '真实模型实验未完成；请检查模型配置和网络后重试。' });
  process.exitCode = 1;
}

function hasConfiguredCredential() {
  return configured(process.env.IAR_LLM_API_KEY) !== undefined || configured(process.env.IAR_MODEL_API_KEY) !== undefined;
}

function configured(value) {
  const normalized = value?.trim();
  return normalized && normalized !== 'CHANGE_ME' ? normalized : undefined;
}

function syntheticFunctions() {
  return [
    {
      functionId: 'function.synthetic.rate', pluginId: 'plugin.synthetic.control', actionTypes: ['update'], requiresConfirmation: true,
      inputSchema: { type: 'object', properties: { operation: { type: 'string' }, rate: { type: 'number' }, burst: { type: 'number' } }, required: ['operation', 'rate', 'burst'], additionalProperties: false }
    },
    {
      functionId: 'function.synthetic.query', pluginId: 'plugin.synthetic.query', actionTypes: ['query'], requiresConfirmation: false,
      inputSchema: { type: 'object', properties: { operation: { type: 'string' } }, required: ['operation'], additionalProperties: false }
    }
  ];
}

function modelFailureOutcome(reasonCode) {
  return { nextStage: 'unavailable', execute: false, reasonCode: `model_${String(reasonCode).slice(0, 80)}`, gates: emptyGates() };
}

function emptyGates() {
  return { semanticFrameValidated: false, descriptorMatched: false, schemaValidated: false, parameterCollectionCompleted: false, policyValidated: false, idempotencyValidated: false, confirmationSatisfied: false, handlerReachable: false };
}

function isAuthorizedRoute(functionId, pluginId) {
  return (functionId === 'function.synthetic.rate' && pluginId === 'plugin.synthetic.control') || (functionId === 'function.synthetic.query' && pluginId === 'plugin.synthetic.query');
}

function ratio(value, total) {
  return total === 0 ? 0 : Number((value / total).toFixed(4));
}

function writeReport(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
