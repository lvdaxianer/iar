import { criticalFieldHash, createInitialContext } from '@iar/runtime';
import { SCHEMA_VERSIONS, type ActionType, type BehaviorContext, type JsonValue } from '@iar/contracts';
import type { PluginScopeDescriptor } from '@iar/plugins';

export type WorkflowEvaluationStage = 'normal' | 'function_selection' | 'parameter_collection' | 'awaiting_confirmation' | 'pass_through';

export type WorkflowEvaluationNextStage = 'clarification' | 'awaiting_confirmation' | 'executed' | 'cancelled' | 'pass_through' | 'context_answered' | 'unavailable';

export type WorkflowEvaluationScenario = {
  id: string;
  userText: string;
  currentStage: WorkflowEvaluationStage;
  behaviorContext: BehaviorContext;
  recentMessages: Array<{ role: string; text: string }>;
  pluginDescriptors: readonly PluginScopeDescriptor[];
  structuredInput?: Record<string, JsonValue>;
  pendingAction?: {
    functionId: string;
    pluginId: string;
    riskLevel: string;
    confirmationRequired: boolean;
    input: JsonValue;
  };
  expected: {
    nextStage: WorkflowEvaluationNextStage;
    execute: boolean;
    functionId?: string;
    pluginId?: string;
    reasonCode?: string;
  };
  secrets?: undefined;
};

export const ENABLED_PLUGIN = 'plugin.synthetic.control';
export const DISABLED_PLUGIN = 'plugin.synthetic.disabled';
export const RATE_FUNCTION = 'function.synthetic.rate';
export const QUERY_FUNCTION = 'function.synthetic.query';

const descriptors: readonly PluginScopeDescriptor[] = [
  descriptor(ENABLED_PLUGIN, 'Synthetic rate control', ['update', 'query']),
  descriptor('plugin.synthetic.query', 'Synthetic query', ['query'])
];

function descriptor(pluginId: string, description: string, actionTypes: ActionType[]): PluginScopeDescriptor {
  return { candidateKey: `candidate-${pluginId}`, pluginId, description, actionTypes, capabilities: ['synthetic.read'] };
}

function context(runId: string): BehaviorContext {
  const value = createInitialContext(runId);
  value.recentMessagePolicy = { recentMessageLimit: 8, maxMessageChars: 400 };
  value.integrity.criticalFieldHash = criticalFieldHash(value);
  return value;
}

function finalized(value: BehaviorContext): BehaviorContext {
  value.integrity.criticalFieldHash = criticalFieldHash(value);
  return value;
}

function route(value: BehaviorContext, functionId: string, pluginId: string): BehaviorContext {
  value.route = { functionId, pluginId };
  value.routingScope = { activePluginId: pluginId, candidatePluginIds: [pluginId], actionTypes: ['query', 'update'], continuation: 'reuse' };
  return value;
}

function parameters(value: BehaviorContext, collected: Record<string, JsonValue>, missingFields: string[], invalidFields: string[] = [], conflictFields: string[] = []): BehaviorContext {
  value.collection = {
    kind: 'parameters', functionId: RATE_FUNCTION, pluginId: ENABLED_PLUGIN, schemaVersion: 'synthetic-rate/v1',
    collected, missingFields, invalidFields, conflictFields, attempt: 1,
    presentation: {
      burst: { label: '突发次数', description: '每秒允许的突发次数', control: 'number' },
      rate: { label: '频率', description: '每秒处理次数', control: 'number' }
    }
  };
  value.pending = { kind: 'slot', status: 'required' };
  value.clarification = { mode: 'unresolved', unresolvedStreak: 1, reasonCode: 'parameters_required' };
  value.workflow = { currentStep: 'collecting_parameters', status: 'waiting' };
  return value;
}

function confirmation(value: BehaviorContext): BehaviorContext {
  route(value, RATE_FUNCTION, ENABLED_PLUGIN);
  value.intent = RATE_FUNCTION;
  value.action = { name: 'update', status: 'proposed' };
  value.pending = { kind: 'confirmation', status: 'required' };
  value.confirmation = { state: 'required', scopeHash: 'synthetic-scope' };
  value.workflow = { workflowId: 'sandbox-turn-v1', currentStep: 'awaiting_confirmation', status: 'waiting' };
  return value;
}

function factContext(): BehaviorContext {
  const value = context('workflow-eval-fact-follow-up');
  value.factHistory = {
    records: [{ recordId: 'opaque-fact-1', sequence: 1, sourceEventId: 'synthetic-event-1', functionId: QUERY_FUNCTION, pluginId: 'plugin.synthetic.query', values: { reference: 'verified-value' }, createdAt: '2026-10-23T00:00:00.000Z' }],
    focusRecordId: 'opaque-fact-1'
  };
  return finalized(value);
}

const initial = context('workflow-eval-initial');

const ambiguous = context('workflow-eval-function-selection');
ambiguous.collection = { kind: 'function', candidateFunctionIds: [RATE_FUNCTION, QUERY_FUNCTION], candidateKeys: ['candidate-rate', 'candidate-query'], reasonCode: 'function_ambiguous', attempt: 1 };
ambiguous.pending = { kind: 'selection', status: 'required', options: [{ key: 'candidate-rate', label: 'Synthetic rate control' }, { key: 'candidate-query', label: 'Synthetic query' }] };
ambiguous.clarification = { mode: 'selection', unresolvedStreak: 1, reasonCode: 'function_collection_required', candidateKeys: ['candidate-rate', 'candidate-query'] };
ambiguous.workflow = { currentStep: 'function_selection', status: 'waiting' };

const merge = parameters(route(context('workflow-eval-parameter-merge'), RATE_FUNCTION, ENABLED_PLUGIN), { operation: 'update', rate: 100 }, ['burst']);

const invalid = parameters(route(context('workflow-eval-invalid-parameter'), RATE_FUNCTION, ENABLED_PLUGIN), { operation: 'update', rate: 'fast', unexpected: true }, ['burst'], ['rate', 'unexpected']);

const disabled = route(context('workflow-eval-disabled-plugin'), RATE_FUNCTION, DISABLED_PLUGIN);
disabled.workflow = { currentStep: 'collecting_parameters', status: 'waiting' };
disabled.collection = { kind: 'parameters', functionId: RATE_FUNCTION, pluginId: 'plugin.synthetic.disabled', schemaVersion: 'synthetic-rate/v1', collected: { operation: 'update' }, missingFields: ['rate'], invalidFields: [], conflictFields: [], attempt: 1 };
disabled.pending = { kind: 'slot', status: 'required' };

const decline = confirmation(context('workflow-eval-decline'));

const newTopic = parameters(route(context('workflow-eval-new-topic'), RATE_FUNCTION, ENABLED_PLUGIN), { operation: 'update', rate: 100 }, ['burst']);

const stableUnknown = route(context('workflow-eval-stable-unknown'), RATE_FUNCTION, ENABLED_PLUGIN);
stableUnknown.workflow = { currentStep: 'collecting_parameters', status: 'waiting' };

const noCandidates = context('workflow-eval-no-candidates');

export const WORKFLOW_EVALUATION_SCENARIOS: readonly WorkflowEvaluationScenario[] = [
  { id: 'initial-function-missing', userText: '帮我处理这个请求', currentStage: 'normal', behaviorContext: finalized(initial), recentMessages: [], pluginDescriptors: descriptors, expected: { nextStage: 'clarification', execute: false } },
  { id: 'function-selection-is-ambiguous', userText: '帮我处理一下', currentStage: 'function_selection', behaviorContext: finalized(ambiguous), recentMessages: [{ role: 'assistant', text: '请选择功能' }], pluginDescriptors: descriptors, expected: { nextStage: 'clarification', execute: false } },
  { id: 'parameter-merge-current-value-wins', userText: '改成每秒 200 次', currentStage: 'parameter_collection', behaviorContext: finalized(merge), recentMessages: [{ role: 'assistant', text: '请补充突发次数' }], pluginDescriptors: descriptors, structuredInput: { rate: 200 }, expected: { nextStage: 'clarification', execute: false, functionId: RATE_FUNCTION, pluginId: ENABLED_PLUGIN, reasonCode: 'parameters_required' } },
  { id: 'invalid-parameter-needs-clarification', userText: '频率填 fast，其他不用填', currentStage: 'parameter_collection', behaviorContext: finalized(invalid), recentMessages: [{ role: 'assistant', text: '请填写频率' }], pluginDescriptors: descriptors, expected: { nextStage: 'clarification', execute: false, functionId: RATE_FUNCTION, pluginId: ENABLED_PLUGIN, reasonCode: 'parameters_invalid' } },
  { id: 'disabled-plugin-cannot-recover', userText: '改成每秒 200 次', currentStage: 'parameter_collection', behaviorContext: finalized(disabled), recentMessages: [{ role: 'assistant', text: '请补充频率' }], pluginDescriptors: descriptors, expected: { nextStage: 'unavailable', execute: false, functionId: RATE_FUNCTION, pluginId: DISABLED_PLUGIN, reasonCode: 'plugin_unavailable' } },
  { id: 'stable-route-unknown-frame', userText: '改成每秒 200 次', currentStage: 'parameter_collection', behaviorContext: finalized(stableUnknown), recentMessages: [{ role: 'assistant', text: '请补充频率' }], pluginDescriptors: descriptors, expected: { nextStage: 'clarification', execute: false, functionId: RATE_FUNCTION, pluginId: ENABLED_PLUGIN } },
  { id: 'awaiting-confirmation-user-declines', userText: '不用了', currentStage: 'awaiting_confirmation', behaviorContext: finalized(decline), recentMessages: [{ role: 'assistant', text: '是否确认修改？' }], pluginDescriptors: descriptors, pendingAction: { functionId: RATE_FUNCTION, pluginId: ENABLED_PLUGIN, riskLevel: 'high', confirmationRequired: true, input: { operation: 'update', rate: 200, burst: 20 } }, expected: { nextStage: 'cancelled', execute: false, functionId: RATE_FUNCTION, pluginId: ENABLED_PLUGIN } },
  { id: 'parameter-collection-new-topic', userText: '算了，换个话题', currentStage: 'parameter_collection', behaviorContext: finalized(newTopic), recentMessages: [{ role: 'assistant', text: '请补充突发次数' }], pluginDescriptors: descriptors, structuredInput: { burst: 20 }, expected: { nextStage: 'pass_through', execute: false } },
  { id: 'verified-fact-follow-up', userText: '刚才那个值是多少？', currentStage: 'normal', behaviorContext: factContext(), recentMessages: [{ role: 'user', text: '查询一下' }], pluginDescriptors: descriptors, expected: { nextStage: 'context_answered', execute: false } },
  { id: 'no-authorized-candidate-is-pass-through', userText: '今天天气怎么样', currentStage: 'pass_through', behaviorContext: finalized(noCandidates), recentMessages: [], pluginDescriptors: [], expected: { nextStage: 'pass_through', execute: false } },
  { id: 'confirmation-state-keeps-route', userText: '确认执行', currentStage: 'awaiting_confirmation', behaviorContext: finalized(confirmation(context('workflow-eval-confirmation'))), recentMessages: [{ role: 'assistant', text: '是否确认修改？' }], pluginDescriptors: descriptors, expected: { nextStage: 'awaiting_confirmation', execute: false, functionId: RATE_FUNCTION, pluginId: ENABLED_PLUGIN } }
];
