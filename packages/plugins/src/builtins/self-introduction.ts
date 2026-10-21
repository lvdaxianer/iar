/** 提供 IAR 内置的自我介绍业务 Plugin。 */
import { SCHEMA_VERSIONS, type BusinessPluginManifest, type FunctionDefinition, type JsonSchema, type JsonValue } from '@iar/contracts';
import type { FunctionHandler, FunctionHandlerResult, PluginPackage } from '../sdk/index.js';

/** 自我介绍 Plugin 的稳定标识。 */
export const SELF_INTRODUCTION_PLUGIN_ID = 'iar.self-introduction';
/** 自我介绍 Function 的稳定标识。 */
export const SELF_INTRODUCTION_FUNCTION_ID = 'iar.self-introduction';
/** 额外提示词的最大字符数，避免用户配置无界进入模型上下文。 */
export const SELF_INTRODUCTION_MAX_PROMPT_LENGTH = 1000;
/** 自我介绍 Handler 的稳定非法输入错误码。 */
const SELF_INTRODUCTION_INVALID_INPUT_CODE = 'self_introduction.invalid_input';
/** 自我介绍一次最多接收的能力描述数量。 */
const MAX_INTRODUCTION_PLUGINS = 128;
/** 单条能力描述的最大字符数。 */
const MAX_PLUGIN_DESCRIPTION_LENGTH = 400;

/** 自我介绍输入中的能力摘要。 */
type IntroductionPlugin = { pluginId: string; functionId: string; description: string };

/** 自我介绍 Function 输入。 */
type IntroductionInput = { plugins: IntroductionPlugin[]; extraPrompt?: string };

/** 内置自我介绍 Plugin 的业务 Manifest。 */
export const selfIntroductionManifest: BusinessPluginManifest = {
  apiVersion: 'iar.dev/v1', schemaVersion: 'iar.plugin-manifest/v1', pluginId: SELF_INTRODUCTION_PLUGIN_ID,
  pluginKind: 'business', scope: 'plugin', version: '1.0.0',
  description: '介绍当前 Agent 已启用的 Plugin 能力', capabilities: ['iar.introspection'],
  lifecycle: { entrypoint: '@iar/plugins/builtins/self-introduction' },
  policy: { riskLevel: 'low', requiresConfirmation: false, allowedCapabilities: ['iar.introspection'] }, dependencies: []
};

/** 自我介绍 Function 的输入输出契约。 */
export const selfIntroductionFunction: FunctionDefinition = {
  schemaVersion: SCHEMA_VERSIONS.function, functionId: SELF_INTRODUCTION_FUNCTION_ID,
  version: selfIntroductionManifest.version, name: '自我介绍', description: selfIntroductionManifest.description,
  actionTypes: ['query'], capabilities: [...selfIntroductionManifest.capabilities], riskLevel: 'low',
  inputSchema: introductionSchema('input'), outputSchema: introductionSchema('output')
};

/** 将受控 JSON 输入转换为结构化能力摘要，非法输入安全失败。
 *
 * @param input - 当前 Agent 提供的已启用能力摘要和额外提示词
 * @returns 结构化聚合结果或稳定失败码
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
const selfIntroductionHandler: FunctionHandler = async (input: JsonValue) => {
  try {
    const request = parseIntroductionInput(input);
    if (!request) return invalidIntroductionInput();
    return { output: request as unknown as JsonValue, status: 'succeeded' };
  } catch {
    return invalidIntroductionInput();
  }
};

/** 可由 Runtime 自动装配的内置 Plugin 包。 */
export const selfIntroductionPlugin: PluginPackage = {
  manifest: selfIntroductionManifest,
  functions: [{ definition: selfIntroductionFunction, operations: [{ name: 'describe-capabilities', kind: 'read', description: '汇总当前已启用 Plugin 的能力描述' }], handler: selfIntroductionHandler }]
};

/** 创建不回显原始输入的稳定非法输入结果。
 *
 * @returns 自我介绍 Handler 的失败结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
function invalidIntroductionInput(): FunctionHandlerResult {
  return { output: { errorCode: SELF_INTRODUCTION_INVALID_INPUT_CODE }, status: 'failed', errorCode: SELF_INTRODUCTION_INVALID_INPUT_CODE };
}

/** 构造有限字段的 JSON Schema，避免输入和输出契约重复漂移。
 *
 * @param direction - 当前 Schema 的输入或输出方向
 * @returns 自我介绍 Function 使用的 JSON Schema
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
function introductionSchema(direction: 'input' | 'output'): JsonSchema {
  const plugin = { type: 'object', properties: { pluginId: { type: 'string', minLength: 1 }, functionId: { type: 'string', minLength: 1 }, description: { type: 'string', minLength: 1, maxLength: MAX_PLUGIN_DESCRIPTION_LENGTH } }, required: ['pluginId', 'functionId', 'description'], additionalProperties: false };
  const success = { type: 'object', properties: { plugins: { type: 'array', maxItems: MAX_INTRODUCTION_PLUGINS, items: plugin }, extraPrompt: { type: 'string', maxLength: SELF_INTRODUCTION_MAX_PROMPT_LENGTH } }, required: ['plugins'], additionalProperties: false };
  if (direction === 'input') return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...success, title: 'self-introduction-input' };
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', oneOf: [success, { type: 'object', properties: { errorCode: { type: 'string', minLength: 1 } }, required: ['errorCode'], additionalProperties: false }], title: 'self-introduction-output' };
}

/** 严格读取自我介绍输入，阻止未知字段、无界数组和空描述进入执行结果。
 *
 * @param input - Function Handler 收到的 JSON 输入
 * @returns 校验后的输入或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
function parseIntroductionInput(input: JsonValue): IntroductionInput | undefined {
  if (!isRecord(input) || !Array.isArray(input.plugins) || input.plugins.length > MAX_INTRODUCTION_PLUGINS) return undefined;
  const extraPrompt = input.extraPrompt;
  if (extraPrompt !== undefined && (typeof extraPrompt !== 'string' || extraPrompt.length > SELF_INTRODUCTION_MAX_PROMPT_LENGTH)) return undefined;
  if (Object.keys(input).some((key) => !['plugins', 'extraPrompt'].includes(key))) return undefined;
  const plugins = input.plugins.map(parseIntroductionPlugin);
  if (plugins.some((plugin) => plugin === undefined)) return undefined;
  return { plugins: plugins as IntroductionPlugin[], ...(extraPrompt === undefined ? {} : { extraPrompt }) };
}

/** 严格读取单条能力描述。
 *
 * @param value - 单条能力摘要的 JSON 值
 * @returns 校验后的能力摘要或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
function parseIntroductionPlugin(value: JsonValue): IntroductionPlugin | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => !['pluginId', 'functionId', 'description'].includes(key))) return undefined;
  const { pluginId, functionId, description } = value;
  return typeof pluginId === 'string' && pluginId.length > 0 && typeof functionId === 'string' && functionId.length > 0 && typeof description === 'string' && description.length > 0 && description.length <= MAX_PLUGIN_DESCRIPTION_LENGTH ? { pluginId, functionId, description } : undefined;
}

/** 判断输入是否为非数组 JSON 对象。
 *
 * @param value - 待判断的 JSON 值
 * @returns 是否为非空对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
