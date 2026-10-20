/**
 * 提供确定性的 human transfer Function Plugin 示例。
 *
 * 该示例只返回本地人工转交 fixture，不连接真实队列或客服系统；它用于
 * 验证高风险转交 capability、confirmation policy 和严格输入输出 contract。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { FunctionPluginManifest, JsonValue } from '@iar/contracts';
import type { PluginHandler, PluginRegistration } from '@iar/plugins';

/** human transfer 的高风险转交 Manifest。 */
export const humanTransferManifest: FunctionPluginManifest = {
  apiVersion: 'iar.dev/v1',
  schemaVersion: 'iar.plugin-manifest/v1',
  pluginId: 'human-transfer-v1',
  pluginKind: 'function',
  scope: 'function',
  functionId: 'human.transfer',
  version: '1.0.0',
  description: '将行为请求转交人工队列的示例插件',
  actionTypes: ['query', 'transfer'],
  capabilities: ['human.transfer'],
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { reason: { type: 'string', minLength: 1, maxLength: 240 }, summary: { type: 'string', minLength: 1, maxLength: 2000 } },
    required: ['reason', 'summary'],
    additionalProperties: false
  },
  outputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    oneOf: [
      { type: 'object', properties: { accepted: { const: true }, queue: { const: 'human.support' }, handoffId: { type: 'string', minLength: 1 } }, required: ['accepted', 'queue', 'handoffId'], additionalProperties: false },
      { type: 'object', properties: { accepted: { const: false }, errorCode: { type: 'string', minLength: 1 } }, required: ['accepted', 'errorCode'], additionalProperties: false }
    ]
  },
  lifecycle: { entrypoint: './dist/examples/plugins/human-transfer/src/index.js' },
  policy: { riskLevel: 'high', requiresConfirmation: true, allowedCapabilities: ['human.transfer'] },
  dependencies: []
};

/**
 * 从 JSON-safe 输入中读取严格人工转交字段。
 *
 * @param input - SDK 传入的 JSON 输入
 * @returns 校验后的转交字段或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function transferInput(input: JsonValue): { reason: string; summary: string } | undefined {
  try {
    // 非对象、数组或未知字段必须在读取字段前拒绝。
    if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.keys(input).some((key) => !['reason', 'summary'].includes(key))) return undefined;
    const reason = input.reason;
    const summary = input.summary;
    // 转交理由和摘要必须同时满足类型、长度和非空约束。
    return typeof reason === 'string' && reason.trim().length > 0 && reason.length <= 240 && typeof summary === 'string' && summary.trim().length > 0 && summary.length <= 2000 ? { reason: reason.trim(), summary: summary.trim() } : undefined;
  } catch {
    // 运行时 getter、Proxy 或结构异常统一按非法输入 fail-closed。
    return undefined;
  }
}

/**
 * 返回稳定 handoff fixture，不把原始说明或凭据写入结果。
 *
 * @param input - SDK 传入的 JSON 输入
 * @returns 符合 Manifest outputSchema 的结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export const humanTransferHandler: PluginHandler = async (input) => {
  // 输入校验失败只能返回稳定错误码，不能返回转交说明或凭据。
  if (!transferInput(input)) return { output: { accepted: false, errorCode: 'human.invalid_input' }, status: 'failed', errorCode: 'human.invalid_input' };
  return { output: { accepted: true, queue: 'human.support', handoffId: 'handoff-fixture-1' }, status: 'succeeded' };
};

/**
 * 可直接交给 PluginHost.install 的 human transfer 注册对象。
 *
 * @returns 绑定 Manifest 和 Handler 的插件注册对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export const humanTransferPlugin: PluginRegistration = { manifest: humanTransferManifest, handler: humanTransferHandler };
