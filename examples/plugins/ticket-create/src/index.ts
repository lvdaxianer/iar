/**
 * 提供确定性的 ticket create Function Plugin 示例。
 *
 * 该示例只返回本地 ticket fixture，不调用真实工单系统；它用于验证
 * 高风险写入 capability、confirmation policy 和 SDK Handler contract。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { SCHEMA_VERSIONS, type BusinessPluginManifest, type FunctionDefinition, type JsonValue } from '@iar/contracts';
import { definePlugin, type FunctionHandler, type PluginPackage } from '@iar/plugin';

/** ticket create 的高风险写入 Manifest。 */
export const ticketCreateManifest: BusinessPluginManifest = {
  apiVersion: 'iar.dev/v1',
  schemaVersion: 'iar.plugin-manifest/v1',
  pluginId: 'ticket-create-v1',
  pluginKind: 'business',
  scope: 'plugin',
  version: '1.0.0',
  description: '创建确定性工单的示例插件',
  capabilities: ['ticket.write'],
  lifecycle: { entrypoint: './dist/examples/plugins/ticket-create/src/index.js' },
  policy: { riskLevel: 'high', requiresConfirmation: true, allowedCapabilities: ['ticket.write'] },
  dependencies: []
};

export const ticketCreateFunction: FunctionDefinition = {
  schemaVersion: SCHEMA_VERSIONS.function,
  functionId: 'ticket.create',
  version: ticketCreateManifest.version,
  name: ticketCreateManifest.description,
  description: ticketCreateManifest.description,
  actionTypes: ['query', 'create'],
  capabilities: [...ticketCreateManifest.capabilities],
  riskLevel: ticketCreateManifest.policy.riskLevel,
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { title: { type: 'string', minLength: 1, maxLength: 120 }, description: { type: 'string', minLength: 1, maxLength: 2000 }, priority: { enum: ['low', 'medium', 'high'] } },
    required: ['title', 'description', 'priority'],
    additionalProperties: false
  },
  outputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    oneOf: [
      { type: 'object', properties: { accepted: { const: true }, ticketId: { type: 'string', minLength: 1 }, status: { const: 'created' } }, required: ['accepted', 'ticketId', 'status'], additionalProperties: false },
      { type: 'object', properties: { accepted: { const: false }, errorCode: { type: 'string', minLength: 1 } }, required: ['accepted', 'errorCode'], additionalProperties: false }
    ]
  }
};

/**
 * 从 JSON-safe 输入中读取严格工单字段。
 *
 * @param input - SDK 传入的 JSON 输入
 * @returns 校验后的工单字段或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function ticketInput(input: JsonValue): { title: string; description: string; priority: 'low' | 'medium' | 'high' } | undefined {
  try {
    // 非对象、数组或未知字段必须在读取字段前拒绝。
    if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.keys(input).some((key) => !['title', 'description', 'priority'].includes(key))) return undefined;
    const title = input.title;
    const description = input.description;
    const priority = input.priority;
    // 标题、描述和优先级必须同时满足类型、长度和枚举约束。
    return typeof title === 'string' && title.trim().length > 0 && title.length <= 120 && typeof description === 'string' && description.trim().length > 0 && description.length <= 2000 && (priority === 'low' || priority === 'medium' || priority === 'high') ? { title: title.trim(), description: description.trim(), priority } : undefined;
  } catch {
    // 运行时 getter、Proxy 或结构异常统一按非法输入 fail-closed。
    return undefined;
  }
}

/**
 * 返回稳定 ticket fixture，不把描述或 secret 复制到结果。
 *
 * @param input - SDK 传入的 JSON 输入
 * @returns 符合 Manifest outputSchema 的结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export const ticketCreateHandler: FunctionHandler = async (input) => {
  // 输入校验失败只能返回稳定错误码，不能返回标题或描述。
  if (!ticketInput(input)) return { output: { accepted: false, errorCode: 'ticket.invalid_input' }, status: 'failed', errorCode: 'ticket.invalid_input', response: { schemaVersion: SCHEMA_VERSIONS.functionResponse, mode: 'model' } };
  return { output: { accepted: true, ticketId: 'ticket-fixture-1', status: 'created' }, status: 'succeeded', response: { schemaVersion: SCHEMA_VERSIONS.functionResponse, mode: 'model' } };
};

/**
 * 可直接交给 PluginHost.install 的 ticket create 注册对象。
 *
 * @returns 绑定 Manifest 和 Handler 的插件注册对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export const ticketCreatePlugin: PluginPackage = definePlugin({ manifest: ticketCreateManifest, functions: [{ definition: ticketCreateFunction, operations: [{ name: 'create', kind: 'action', description: '创建工单' }], handler: ticketCreateHandler }] });
