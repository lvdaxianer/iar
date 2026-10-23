/**
 * 将工作流实验结果压缩为可安全展示的阶段报告。
 *
 * 报告不接受或复制用户原文、prompt、模型回复、参数值和凭据。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-23
 */
import type { WorkflowEvaluationNextStage } from './workflow-evaluation-fixtures.js';
import type { WorkflowEvaluationOutcome } from './workflow-evaluation-oracle.js';

const MAX_REPORT_SCENARIOS = 64;
const MAX_IDENTIFIER_LENGTH = 120;

/** 报告构造所需的最小单场景输入。 */
export type WorkflowEvaluationReportInput = {
  scenarioId: string;
  expected: {
    nextStage: WorkflowEvaluationNextStage;
    execute: boolean;
    functionId?: string;
    pluginId?: string;
  };
  actual: Pick<WorkflowEvaluationOutcome, 'nextStage' | 'execute' | 'reasonCode' | 'functionId' | 'pluginId'>;
};

/** 单场景的有界转移证据。 */
export type WorkflowEvaluationReportScenario = {
  scenarioId: string;
  expected: { nextStage: WorkflowEvaluationNextStage; execute: boolean; functionId?: string; pluginId?: string };
  actual: { nextStage: WorkflowEvaluationNextStage; execute: boolean; reasonCode: string; functionId?: string; pluginId?: string };
  passed: boolean;
};

/** 不包含原始输入的工作流评估报告。 */
export type WorkflowEvaluationReport = {
  schemaVersion: 'iar.workflow-evaluation-report/v1';
  summary: { total: number; passed: number; failed: number };
  scenarios: readonly WorkflowEvaluationReportScenario[];
};

/**
 * 生成只含阶段、路由标识和计数的确定性报告。
 *
 * @param inputs - 已由调用方脱敏的场景观测
 * @returns 有界评估报告
 * @author lvdaxianer@yeah.net
 * @date 2026-10-23
 */
export function buildWorkflowEvaluationReport(inputs: readonly WorkflowEvaluationReportInput[]): WorkflowEvaluationReport {
  const scenarios = inputs.slice(0, MAX_REPORT_SCENARIOS).map(toReportScenario);
  const passed = scenarios.filter((scenario) => scenario.passed).length;
  return { schemaVersion: 'iar.workflow-evaluation-report/v1', summary: { total: scenarios.length, passed, failed: scenarios.length - passed }, scenarios };
}

function toReportScenario(input: WorkflowEvaluationReportInput): WorkflowEvaluationReportScenario {
  const expected = { nextStage: input.expected.nextStage, execute: input.expected.execute, ...routeFields(input.expected) };
  const actual = { nextStage: input.actual.nextStage, execute: input.actual.execute, reasonCode: boundIdentifier(input.actual.reasonCode), ...routeFields(input.actual) };
  return { scenarioId: boundIdentifier(input.scenarioId), expected, actual, passed: expected.nextStage === actual.nextStage && expected.execute === actual.execute && expected.functionId === actual.functionId && expected.pluginId === actual.pluginId };
}

function routeFields(value: { functionId?: string; pluginId?: string }): { functionId?: string; pluginId?: string } {
  return {
    ...(value.functionId === undefined ? {} : { functionId: boundIdentifier(value.functionId) }),
    ...(value.pluginId === undefined ? {} : { pluginId: boundIdentifier(value.pluginId) })
  };
}

function boundIdentifier(value: string): string {
  return value.trim().slice(0, MAX_IDENTIFIER_LENGTH);
}
