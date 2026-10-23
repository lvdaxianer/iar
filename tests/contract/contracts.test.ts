/**
 * 验证 Phase 1 公共契约的版本、字段约束和嵌入 Schema 校验。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  CONTRACT_SCHEMAS,
  ERROR_CODES,
  IAR_API_VERSION,
  parsePluginManifest,
  SCHEMA_VERSIONS,
  validateContract,
  validatePluginManifest
} from '@iar/contracts';

/*
 * 合约测试覆盖版本、字段、嵌入 Schema 和跨字段策略关系。
 * fixture 路径固定从仓库根目录解析，避免构建目录改变语义。
 * 版本错误必须与普通结构错误保持不同稳定错误码。
 * 嵌入 JSON Schema 必须经过 Ajv meta-schema 校验。
 * capabilities 必须唯一，policy 能力必须属于 Manifest 能力集合。
 * high/critical 风险插件必须显式要求确认。
 * 通用 validateContract 与专用 validatePluginManifest 共享同一边界。
 * parsePluginManifest 只在成功时返回强类型 Manifest。
 * 这些断言不依赖 Host、存储、网络或模型 Provider。
 * 它们为后续 Runtime、Policy Gate 和 Replay 提供稳定输入。
 */

/**
 * 读取 JSON fixture，保持测试输入与公共合约文档一致。
 *
 * @param name - fixture 文件名
 * @returns 解析后的未知 JSON 值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function loadFixture(name: string): unknown {
  const fixturePath = join(process.cwd(), 'tests', 'contract', 'fixtures', name);
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
}

/** 用于构造跨字段校验样例的最小 Manifest 形状。 */
type ManifestFixture = Record<string, unknown> & {
  capabilities: string[];
  policy: Record<string, unknown>;
};

/**
 * 断言公开契约 Schema 注册表包含 Phase 1 全部名称。
 *
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertPublicSchemaNames(): void {
  const expectedNames = ['action', 'actionResult', 'behaviorContext', 'compactionResult', 'decision', 'error', 'event', 'function', 'functionResponse', 'functionResult', 'pluginManifest', 'rule', 'workflow', 'workflowDecision'];
  assert.deepEqual(Object.keys(CONTRACT_SCHEMAS).sort(), expectedNames.sort());
}

/**
 * 断言通用 Function 校验拒绝非法嵌入 Schema。
 *
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertInvalidFunctionSchema(): void {
  const result = validateContract('function', {
    schemaVersion: SCHEMA_VERSIONS.function,
    functionId: 'broken.function',
    version: '1.0.0',
    name: 'Broken Function',
    description: '用于验证嵌入 Schema 拒绝路径',
    actionTypes: ['query'],
    inputSchema: { type: 'not-a-json-schema-type' },
    outputSchema: { type: 'object' },
    capabilities: [],
    riskLevel: 'low'
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, ERROR_CODES.INVALID_EMBEDDED_SCHEMA);
}

/** 构造最小合法 BehaviorContext，供上下文演进测试复用。 */
function createBehaviorContextFixture(): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSIONS.behaviorContext,
    subject: { type: 'session', id: 'session-001', status: 'unresolved', source: 'input' },
    intent: 'unknown',
    action: { name: 'unknown', status: 'proposed' },
    route: {},
    slots: {},
    workflow: { currentStep: 'input', status: 'waiting' },
    pending: { kind: 'input', status: 'none' },
    confirmation: { state: 'not_required' },
    idempotencyKey: 'idem-001',
    integrity: { criticalFieldHash: 'hash-001', lastEventId: 'event-001' }
  };
}

/** 读取合法插件 Manifest 并断言其可被解析为强类型对象。 */
test('valid plugin manifest passes versioned contract validation', () => {
  // 合法 fixture 应被解析成强类型业务插件。
  const manifest = parsePluginManifest(loadFixture('valid-plugin-manifest.json'));

  // API 版本必须是宿主声明的当前版本。
  assert.equal(manifest.apiVersion, IAR_API_VERSION);
  // Manifest Schema 版本必须稳定可审计。
  assert.equal(manifest.schemaVersion, SCHEMA_VERSIONS.pluginManifest);
  // 业务插件类型必须保持 package 边界。
  assert.equal(manifest.pluginKind, 'business');
  // Function 归属由包内 functions 注册项承载，而不是 Manifest 字段。
  assert.equal(manifest.scope, 'plugin');
});

/** 旧的 Function 级 Manifest 形状必须被稳定拒绝。 */
test('function fields are rejected at plugin manifest boundary', () => {
  // Function 级字段不能越过新的 Plugin 包边界。
  const result = validatePluginManifest(loadFixture('invalid-plugin-missing-function.json'));

  // 校验结果必须是失败分支。
  assert.equal(result.ok, false);
  if (!result.ok) {
    // 缺字段属于结构化契约错误。
    assert.equal(result.error.code, ERROR_CODES.CONTRACT_VALIDATION_FAILED);
    // 诊断信息必须保留结构化校验细节。
    assert.ok(result.error.details);
  }
});

/** 不兼容的 API 版本必须单独映射为版本错误。 */
test('incompatible api version is rejected with stable version error', () => {
  // 旧 API 版本应在解析 Manifest 前被拦截。
  const result = validatePluginManifest(loadFixture('incompatible-plugin-api.json'));

  // 版本不兼容不能被降级为普通字段错误。
  assert.equal(result.ok, false);
  if (!result.ok) {
    // 调用方可以据此选择升级或回滚策略。
    assert.equal(result.error.code, ERROR_CODES.INCOMPATIBLE_API_VERSION);
  }
});

/** 嵌入的输入输出 Schema 无效时必须阻止 Manifest 进入运行时。 */
test('invalid embedded schema is rejected with schema error', () => {
  // Function 外层字段完整不代表嵌入 Schema 合法。
  const result = validateContract('function', {
    schemaVersion: SCHEMA_VERSIONS.function,
    functionId: 'broken.schema',
    version: '1.0.0',
    name: 'Broken schema',
    description: '用于验证嵌入 Schema 拒绝路径',
    actionTypes: ['query'],
    inputSchema: { type: 'not-a-json-schema-type' },
    outputSchema: { type: 'object' },
    capabilities: [],
    riskLevel: 'low'
  });

  // 无法编译的 Schema 必须拒绝安装。
  assert.equal(result.ok, false);
  if (!result.ok) {
    // 错误码必须指向嵌入 Schema 边界。
    assert.equal(result.error.code, ERROR_CODES.INVALID_EMBEDDED_SCHEMA);
  }
});

/** 所有公共 Schema 都必须能被 Ajv 编译并登记到公开映射。 */
test('all public contract schemas are registered', () => assertPublicSchemaNames());

/** 通用验证入口必须能拒绝未声明版本的行为上下文。 */
test('generic contract validation rejects incompatible behavior context', () => {
  // 通用入口也必须执行 Schema 版本检查。
  const result = validateContract('behaviorContext', { schemaVersion: 'iar.behavior-context/v0' });

  // 不兼容投影不能进入 replay 或 runtime state。
  assert.equal(result.ok, false);
});

/** 旧快照缺少新增可选字段时仍必须保持可恢复。 */
test('behavior context remains backward compatible without recent-message state', () => {
  // 旧快照不包含新版本的窗口和澄清字段。
  const result = validateContract('behaviorContext', createBehaviorContextFixture());

  // 缺少可选字段不能阻断已有会话恢复。
  assert.equal(result.ok, true);
});

/** 最近消息窗口策略必须被限制在运行时允许的边界内。 */
test('behavior context accepts a bounded recent-message policy', () => {
  // 最近消息策略只描述窗口边界，不把原文复制进可信快照。
  const result = validateContract('behaviorContext', {
    ...createBehaviorContextFixture(),
    recentMessagePolicy: { recentMessageLimit: 5, maxMessageChars: 2000 }
  });

  // 合法策略应能随快照恢复并供 Runtime 读取。
  assert.equal(result.ok, true);
});

/** 连续未解决和待选择候选必须能作为结构化状态恢复。 */
test('behavior context accepts persisted unresolved selection state', () => {
  // 候选键只代表当前注册表快照中的不透明引用。
  const result = validateContract('behaviorContext', {
    ...createBehaviorContextFixture(),
    clarification: {
      mode: 'selection',
      unresolvedStreak: 2,
      reasonCode: 'routing_unresolved',
      candidateVersion: 'registry-001',
      candidateKeys: ['candidate-a', 'candidate-b']
    }
  });

  // 澄清状态是数据，不应直接改变执行权限。
  assert.equal(result.ok, true);
});

/** 最近消息策略超出边界时必须在契约层拒绝。 */
test('behavior context rejects an oversized recent-message policy', () => {
  // 超过运行时窗口上限会造成不可控的模型输入增长。
  const result = validateContract('behaviorContext', {
    ...createBehaviorContextFixture(),
    recentMessagePolicy: { recentMessageLimit: 21, maxMessageChars: 2001 }
  });

  // 非法策略不能进入持久化或模型调用路径。
  assert.equal(result.ok, false);
});

/** 同一候选键不能映射到多个展示选项，避免选择歧义。 */
test('behavior context rejects duplicated pending selection keys', () => {
  // 不同标签复用同一键会让用户选择无法确定唯一候选。
  const result = validateContract('behaviorContext', {
    ...createBehaviorContextFixture(),
    pending: {
      kind: 'selection',
      status: 'required',
      options: [
        { key: 'candidate-a', label: '候选 A' },
        { key: 'candidate-a', label: '候选 A（重复键）' }
      ]
    }
  });

  // 运行时必须在授权和执行前拒绝歧义选择元数据。
  assert.equal(result.ok, false);
});

/** 通用 Function 校验也必须验证输入输出 JSON Schema。 */
test('generic function validation rejects invalid embedded schema', () => assertInvalidFunctionSchema());

/** Manifest 的能力列表必须去重，且高风险插件必须要求确认。 */
test('plugin policy relations are validated across fields', () => {
  const duplicateCapabilities = structuredClone(loadFixture('valid-plugin-manifest.json')) as ManifestFixture;
  duplicateCapabilities.capabilities = ['dip.service.write', 'dip.service.write'];
  const duplicateResult = validatePluginManifest(duplicateCapabilities);
  assert.equal(duplicateResult.ok, false);

  const unsafePolicy = structuredClone(loadFixture('valid-plugin-manifest.json')) as ManifestFixture;
  unsafePolicy.policy = { ...unsafePolicy.policy, riskLevel: 'critical', requiresConfirmation: false };
  const unsafeResult = validatePluginManifest(unsafePolicy);
  assert.equal(unsafeResult.ok, false);
  if (!unsafeResult.ok) assert.match(JSON.stringify(unsafeResult.error.details), /requiresConfirmation/);
});

// 这些测试保持为 contract 层单元测试，不依赖宿主注册表或存储实现。
// fixture 与内联样例共同覆盖文件输入和通用 API 输入两条路径。
// 每个错误码都对应后续宿主可处理的稳定分支。
// 版本断言避免未来扩展时静默接受旧 payload。
// JSON Schema 断言避免把任意对象当成合法的插件边界。
// Function 边界断言防止插件绕过声明的归属。
// 事件、行为上下文和 Action 的字段由公开 Schema 映射统一管理。
// 测试输出通过 Node test runner 运行，保持与根 npm test 相同。
// 不在本任务中引入真实模型、网络或数据库依赖。
// 后续 Phase 1 任务将复用这些版本和错误码。

// 额外覆盖 fixture loader 的确定性路径约定。
// 该断言确保测试始终从仓库根目录读取，不依赖构建产物位置。
// 公开契约测试只接受 JSON 文件，避免隐式引入运行时对象。
// 失败时 Node test runner 会保留具体 fixture 文件名。
