/**
 * 定义 Action、Decision 和 ErrorResult Schema。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { Type } from '@sinclair/typebox';
import { ERROR_CODES } from './errors.js';
import { JsonValueSchema, RiskLevelSchema } from './schema-primitives.js';
import { SCHEMA_VERSIONS } from './versions.js';

/** 待执行的副作用 Action。 */
export const ActionDefinitionSchema = Type.Object({
  // Action Schema 版本用于请求和结果解析。
  schemaVersion: Type.Literal(SCHEMA_VERSIONS.action),
  actionId: Type.String({ minLength: 1 }),
  // runId 绑定可恢复运行实例。
  runId: Type.String({ minLength: 1 }),
  // Function 和 Plugin 在副作用前固定。
  functionId: Type.String({ minLength: 1 }),
  pluginId: Type.String({ minLength: 1 }),
  // 幂等键防止重试产生第二次副作用。
  idempotencyKey: Type.String({ minLength: 1 }),
  input: JsonValueSchema,
  riskLevel: RiskLevelSchema,
  confirmationRequired: Type.Boolean()
}, { additionalProperties: false });

/** Action 的可审计执行结果。 */
export const ActionResultSchema = Type.Object({
  // 结果与请求共享 Action Schema 版本。
  schemaVersion: Type.Literal(SCHEMA_VERSIONS.action),
  // actionId 关联原始副作用请求。
  actionId: Type.String({ minLength: 1 }),
  // status 区分接收、执行中和终态。
  status: Type.Union([
    // 调度器已经接收 Action。
    Type.Literal('accepted'),
    // 外部副作用尚未收敛。
    Type.Literal('in_progress'),
    // 外部结果成功并已记录。
    Type.Literal('succeeded'),
    // 外部结果失败且已分类。
    Type.Literal('failed'),
    // Action 被明确取消。
    Type.Literal('cancelled')
  ]),
  // output 只能携带可重放 JSON。
  output: Type.Optional(JsonValueSchema),
  // errorCode 使用稳定错误码。
  errorCode: Type.Optional(Type.String({ minLength: 1 }))
}, { additionalProperties: false });

/** 结构化 Decision 结果，不能直接授予执行权限。 */
export const DecisionResultSchema = Type.Object({
  // Decision 版本用于适配器兼容性判断。
  schemaVersion: Type.Literal(SCHEMA_VERSIONS.decision),
  // decisionType 固定决策所在的运行时边界。
  decisionType: Type.Union([
    // 从输入抽取结构化语义。
    Type.Literal('semantic.extract'),
    // 在有限 Function 候选中选择。
    Type.Literal('function.select'),
    // 在当前 Function 内选择插件。
    Type.Literal('plugin.select'),
    // 产出策略判断而不是执行许可。
    Type.Literal('policy.evaluate'),
    // 生成面向宿主或用户的响应。
    Type.Literal('response.generate')
  ]),
  // 记录产生结果的适配器或规则版本。
  decisionVersion: Type.String({ minLength: 1 }),
  // 明确选择、澄清、拒绝或无候选。
  status: Type.Union([
    // 存在满足阈值的候选。
    Type.Literal('choice'),
    // 候选不可区分，需要澄清。
    Type.Literal('needs_clarification'),
    // 请求或候选被拒绝。
    Type.Literal('rejected'),
    // 没有可执行选择。
    Type.Literal('noul')
  ]),
  // choice 只在可执行选择时出现。
  choice: Type.Optional(Type.String({ minLength: 1 })),
  // score 用于阈值校验。
  score: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  // reasonCode 让拒绝原因可审计。
  reasonCode: Type.String({ minLength: 1 }),
  // candidateIds 保留模型看到的有限集合。
  candidateIds: Type.Array(Type.String({ minLength: 1 }))
}, { additionalProperties: false });

/** 跨包共享的稳定错误结果。 */
export const ErrorResultSchema = Type.Object({
  // 错误结果是跨包共享的版本化载荷。
  schemaVersion: Type.Literal(SCHEMA_VERSIONS.error),
  // code 是机器可判断的稳定分支。
  code: Type.Union(Object.values(ERROR_CODES).map((code) => Type.Literal(code))),
  // message 用于宿主展示和诊断。
  message: Type.String({ minLength: 1 }),
  // retryable 指示调用方能否安全重试。
  retryable: Type.Boolean(),
  // details 承载脱敏后的结构化细节。
  details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  // traceId 将错误关联到运行链路。
  traceId: Type.Optional(Type.String({ minLength: 1 }))
}, { additionalProperties: false });
