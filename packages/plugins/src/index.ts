/**
 * 暴露插件开发 SDK、注册宿主、生命周期和依赖排序能力。
 *
 * SDK 与 Host 保留在包内独立子目录，但通过同一个 workspace 包入口提供。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
export * from './sdk/index.js';
export * from './host/index.js';
export * from './builtins/self-introduction.js';
