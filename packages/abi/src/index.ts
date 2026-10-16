/** 跨语言 control-plane ABI 的类型、校验和兼容性入口。 */
/** 类型定义保持与非 TypeScript 客户端的 wire names 一致。 */
export * from './types.js';
/** 校验入口统一映射稳定错误码并 fail-closed。 */
export * from './validation.js';
