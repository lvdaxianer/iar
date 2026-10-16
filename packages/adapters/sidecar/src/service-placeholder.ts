/**
 * 仅为 sidecar 类型导入提供稳定的相对路径桥接。
 * 实际实现由 Service adapter 的公开类型承担。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export type { ServiceApi, ServiceApiRequest, ServiceApiResponse } from '@iar/adapters-service';
