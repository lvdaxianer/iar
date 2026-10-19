/**
 * 提供账户与权限（account.privilege）Function 插件。
 *
 * 模拟企业数据平台的权限子系统：search 从本地权限知识库做确定性检索
 * 返回 top3（带 score 与 answer），mine 返回本地确定性当前用户权限 fixture，
 * grant 模拟提交授权申请并返回受理号，不产生真实副作用；
 * operation 缺省时知识型问法默认 search，其余按 query 关键词推断。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import type { FunctionPluginManifest, JsonValue } from '@iar/contracts';
import type { PluginHandler, PluginRegistration } from '@iar/plugin-sdk';
import { retrieveKnowledge } from '../knowledge/retrieval.js';
import { fail, findSandboxOperation, parseSandboxInput, sandboxInputSchema, sandboxOutputSchema, succeed, type SandboxOperation } from './common.js';

/** account.privilege 的确定性当前用户权限 fixture。 */
const MY_ACCOUNT: Record<string, JsonValue> = {
  user: 'zhang.wei',
  department: '用户数据组',
  roles: ['数据分析师', '报表订阅者'],
  permissions: [
    { resource: 'dwd_order', scope: '查询（非敏感列）', expiresAt: '2026-11-15' },
    { resource: 'dws_user_gmv_1d', scope: '查询与导出（1 万行以内）', expiresAt: '2026-11-02' },
    { resource: '报表中心', scope: '内部级报表查看', expiresAt: '长期' }
  ],
  pendingApprovals: 1
};

/** account.privilege 的显式操作目录。 */
export const accountPrivilegeOperations: readonly SandboxOperation[] = [
  { name: 'search', kind: 'read', description: '检索账户权限知识库，返回相关度最高的 3 条说明' },
  { name: 'mine', kind: 'read', description: '查看当前账户的角色、权限清单与待审批事项' },
  { name: 'grant', kind: 'action', description: '提交角色或资源的授权申请，进入审批流' }
];

/** account.privilege 的版本化 Function Manifest，policy 声明 high 作为安全上限。 */
export const accountPrivilegeManifest: FunctionPluginManifest = {
  apiVersion: 'iar.dev/v1',
  schemaVersion: 'iar.plugin-manifest/v1',
  pluginId: 'account-privilege-v1',
  pluginKind: 'function',
  scope: 'function',
  functionId: 'account.privilege',
  version: '1.0.0',
  description: '账户与权限插件，提供本人权限查询与授权申请受理的确定性模拟',
  actionTypes: ['query', 'update'],
  capabilities: ['account.read', 'account.grant'],
  inputSchema: sandboxInputSchema(),
  outputSchema: sandboxOutputSchema(),
  lifecycle: { entrypoint: './dist/examples/agent-sandbox/src/functions/account-privilege.js' },
  policy: { riskLevel: 'high', requiresConfirmation: true, allowedCapabilities: ['account.read', 'account.grant'] },
  dependencies: []
};

/**
 * operation 缺省时按 query 关键词推断默认 read 操作。
 *
 * @param query - 用户查询文本
 * @returns 推断出的操作名
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function inferOperation(query: string): string {
  // 只有出现明确的申请动作措辞才推断为 grant，避免"权限申请流程"这类咨询被当成授权请求。
  return /帮我申请|我要申请|我想申请|申请一下|帮我开通|帮我提权/.test(query) ? 'grant' : 'mine';
}

/**
 * 判断 query 是否为知识型问法，用于 operation 缺省时优先默认 search。
 *
 * @param query - 用户查询文本
 * @returns query 非空且命中知识型关键词时返回 true
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function isKnowledgeQuery(query: string): boolean {
  return query.trim().length > 0 && /为什么|如何|怎么|什么是|有哪些|原因|排查|处理|介绍|说明|区别|失败/.test(query);
}

/**
 * 处理权限知识检索、本人权限查询与授权申请受理，全部返回确定性结果。
 *
 * @param input - 统一 Handler 输入
 * @returns 操作结果或稳定错误码
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export const accountPrivilegeHandler: PluginHandler = async (input) => {
  const parsed = parseSandboxInput(input);
  if (!parsed) return fail('account.invalid_input');
  const operation = parsed.operation ?? (isKnowledgeQuery(parsed.query) ? 'search' : inferOperation(parsed.query));
  const op = findSandboxOperation(accountPrivilegeOperations, operation);
  if (!op) return fail('account.unknown_operation');
  if (operation === 'search') {
    if (parsed.query.trim().length === 0) return fail('account.query_required');
    const results = retrieveKnowledge('account.privilege', parsed.query, 3);
    return succeed('search', { results, summary: `账户权限知识库检索完成，命中 ${String(results.length)} 条` });
  }
  if (operation === 'mine') {
    return succeed('mine', { account: MY_ACCOUNT, summary: `当前角色 ${String((MY_ACCOUNT.roles as unknown[]).length)} 个，权限 ${String((MY_ACCOUNT.permissions as unknown[]).length)} 项，待审批 1 项` });
  }
  const role = parsed.params.role ?? (/敏感/.test(parsed.query) ? '敏感字段查询权限' : '高级分析师');
  const resource = parsed.params.resource ?? 'dwd_order';
  return succeed('grant', {
    receipt: `grant-req-${resource}`,
    grantRequestId: `grant-req-${resource}`,
    role,
    resource,
    status: 'pending_approval',
    summary: `已受理「${role}」授权申请（资源 ${resource}），等待数据负责人审批`
  }, { receipt: `grant-req-${resource}`, grantRequestId: `grant-req-${resource}`, role, resource, status: 'pending_approval' });
};

/** 可直接交给 PluginHost.install 的 account.privilege 注册对象。 */
export const accountPrivilegePlugin: PluginRegistration = { manifest: accountPrivilegeManifest, handler: accountPrivilegeHandler };
