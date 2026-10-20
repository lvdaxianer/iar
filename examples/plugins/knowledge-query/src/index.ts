/**
 * 提供确定性的 knowledge query Function Plugin 示例。
 *
 * 该示例只模拟只读知识查询，不访问真实知识库或模型；它用于验证
 * Manifest、输入输出 Schema、低风险 policy 和 Plugin SDK 边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { FunctionPluginManifest, JsonValue } from '@iar/contracts';
import type { PluginHandler, PluginRegistration } from '@iar/plugins';

/** knowledge query 输入的最大长度，避免示例边界接受无界请求。 */
const MAX_QUERY_LENGTH = 500;

/** knowledge query 的版本化、只读 Manifest。 */
export const knowledgeQueryManifest: FunctionPluginManifest = {
  apiVersion: 'iar.dev/v1',
  schemaVersion: 'iar.plugin-manifest/v1',
  pluginId: 'knowledge-query-v1',
  pluginKind: 'function',
  scope: 'function',
  functionId: 'knowledge.query',
  version: '1.0.0',
  description: '查询确定性知识片段的示例插件',
  actionTypes: ['query'],
  capabilities: ['knowledge.read'],
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH }, topK: { type: 'integer', minimum: 1, maximum: 10 } },
    required: ['query', 'topK'],
    additionalProperties: false
  },
  outputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    oneOf: [
      { type: 'object', properties: { accepted: { const: true }, answer: { type: 'string', minLength: 1 }, citations: { type: 'array', items: { type: 'object', properties: { sourceId: { type: 'string', minLength: 1 }, snippet: { type: 'string', minLength: 1 } }, required: ['sourceId', 'snippet'], additionalProperties: false } }, confidence: { type: 'number', minimum: 0, maximum: 1 } }, required: ['accepted', 'answer', 'citations', 'confidence'], additionalProperties: false },
      { type: 'object', properties: { accepted: { const: false }, errorCode: { type: 'string', minLength: 1 } }, required: ['accepted', 'errorCode'], additionalProperties: false }
    ]
  },
  lifecycle: { entrypoint: './dist/examples/plugins/knowledge-query/src/index.js' },
  policy: { riskLevel: 'low', requiresConfirmation: false, allowedCapabilities: ['knowledge.read'] },
  dependencies: []
};

/**
 * 从 JSON-safe 输入中读取严格 query 参数。
 *
 * @param input - SDK 传入的 JSON 输入
 * @returns 校验后的 query 参数或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function queryInput(input: JsonValue): { query: string; topK: number } | undefined {
  try {
    // 非对象、数组或未知字段必须在读取字段前拒绝。
    if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.keys(input).some((key) => !['query', 'topK'].includes(key))) return undefined;
    const query = input.query;
    const topK = input.topK;
    // 查询文本和 topK 必须同时满足类型、长度和范围约束。
    return typeof query === 'string' && query.trim().length > 0 && query.length <= MAX_QUERY_LENGTH && typeof topK === 'number' && Number.isInteger(topK) && topK >= 1 && topK <= 10 ? { query: query.trim(), topK } : undefined;
  } catch {
    // 运行时 getter、Proxy 或结构异常统一按非法输入 fail-closed。
    return undefined;
  }
}

/**
 * 返回稳定知识片段，不回显 query 或任何未验证输入。
 *
 * @param input - SDK 传入的 JSON 输入
 * @returns 符合 Manifest outputSchema 的结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export const knowledgeQueryHandler: PluginHandler = async (input) => {
  // 输入校验先于任何业务输出，避免错误路径复制原始请求。
  const request = queryInput(input);
  if (!request) return { output: { accepted: false, errorCode: 'knowledge.invalid_input' }, status: 'failed', errorCode: 'knowledge.invalid_input' };
  return { output: { accepted: true, answer: '这是本地 knowledge contract fixture 的确定性摘要。', citations: [{ sourceId: 'knowledge.fixture', snippet: '该回答来自本地 contract fixture。' }], confidence: 0.95 }, status: 'succeeded' };
};

/**
 * 可直接交给 PluginHost.install 的 knowledge query 注册对象。
 *
 * @returns 绑定 Manifest 和 Handler 的插件注册对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export const knowledgeQueryPlugin: PluginRegistration = { manifest: knowledgeQueryManifest, handler: knowledgeQueryHandler };
