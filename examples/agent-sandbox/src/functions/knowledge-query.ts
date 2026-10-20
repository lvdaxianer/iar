/**
 * 提供平台通用知识（knowledge.query）Function 插件。
 *
 * 只读检索本地平台通用知识库（中文企业 FAQ），不访问任何外部服务；
 * 通过 knowledge/retrieval.ts 做确定性评分，返回 top3 命中（带 score 与 answer）。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import type { FunctionPluginManifest } from '@iar/contracts';
import type { PluginHandler, PluginRegistration } from '@iar/plugin-sdk';
import { retrieveKnowledge } from '../knowledge/retrieval.js';
import { fail, findSandboxOperation, parseSandboxInput, sandboxInputSchema, sandboxOutputSchema, succeed, type SandboxOperation } from './common.js';

/** knowledge.query 的显式操作目录。 */
export const knowledgeQueryOperations: readonly SandboxOperation[] = [
  { name: 'search', kind: 'read', description: '在平台通用知识库中检索 FAQ，返回相关度最高的 3 条问答' }
];

/** knowledge.query 的版本化 Function Manifest，policy 声明 high 作为安全上限。 */
export const knowledgeQueryManifest: FunctionPluginManifest = {
  apiVersion: 'iar.dev/v1',
  schemaVersion: 'iar.plugin-manifest/v1',
  pluginId: 'knowledge-query-v1',
  pluginKind: 'function',
  scope: 'function',
  functionId: 'knowledge.query',
  version: '1.0.0',
  description: '平台通用知识问答插件，检索本地知识库返回确定性 FAQ 结果',
  actionTypes: ['query'],
  operations: knowledgeQueryOperations,
  capabilities: ['knowledge.read'],
  inputSchema: sandboxInputSchema(),
  outputSchema: sandboxOutputSchema(),
  lifecycle: { entrypoint: './dist/examples/agent-sandbox/src/functions/knowledge-query.js' },
  policy: { riskLevel: 'high', requiresConfirmation: true, allowedCapabilities: ['knowledge.read'] },
  dependencies: []
};

/**
 * 检索平台通用知识库：从 knowledge.query 的本地知识库返回 top3 命中。
 *
 * @param input - 统一 Handler 输入（operation 缺省按 search 处理）
 * @returns 检索结果或稳定错误码
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export const knowledgeQueryHandler: PluginHandler = async (input) => {
  const parsed = parseSandboxInput(input);
  if (!parsed) return fail('knowledge.invalid_input');
  const operation = parsed.operation ?? 'search';
  if (!findSandboxOperation(knowledgeQueryOperations, operation)) return fail('knowledge.unknown_operation');
  if (parsed.query.trim().length === 0) return fail('knowledge.query_required');
  const results = retrieveKnowledge('knowledge.query', parsed.query, 3);
  return succeed('search', { results, summary: `平台知识库检索完成，命中 ${String(results.length)} 条` });
};

/** 可直接交给 PluginHost.install 的 knowledge.query 注册对象。 */
export const knowledgeQueryPlugin: PluginRegistration = { manifest: knowledgeQueryManifest, handler: knowledgeQueryHandler };
