/** 定义 Function 结果交给宿主后的固定回复信封 Schema。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
import { Type } from '@sinclair/typebox';
import { SCHEMA_VERSIONS } from './versions.js';

/** Function 回复正文的最大字符数。 */
export const MAX_FUNCTION_RESPONSE_TEXT_LENGTH = 4000;

/** Function 回复 UI 数据的最大序列化字节数。 */
export const MAX_FUNCTION_RESPONSE_UI_BYTES = 65536;

const responseFields = {
  schemaVersion: Type.Literal(SCHEMA_VERSIONS.functionResponse),
  // ui 的递归 JSON 值由运行时校验，避免在 Handler 外壳内重复注册递归 $id。
  ui: Type.Optional(Type.Unknown())
};

/** Function 的 model/direct/none 三种固定回复形状。 */
export const FunctionResponseSchema = Type.Union([
  Type.Object({ ...responseFields, mode: Type.Literal('model') }, { additionalProperties: false }),
  Type.Object({ ...responseFields, mode: Type.Literal('direct'), text: Type.String({ minLength: 1, maxLength: MAX_FUNCTION_RESPONSE_TEXT_LENGTH }) }, { additionalProperties: false }),
  Type.Object({ ...responseFields, mode: Type.Literal('none') }, { additionalProperties: false })
]);

/** Function Handler 的固定输出外壳。 */
export const FunctionHandlerResultSchema = Type.Object({
  // output 的业务 Schema 由 FunctionDefinition 负责，外壳只要求 JSON 值。
  output: Type.Unknown(),
  status: Type.Union([Type.Literal('succeeded'), Type.Literal('failed')]),
  errorCode: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  response: FunctionResponseSchema
}, { additionalProperties: false });
