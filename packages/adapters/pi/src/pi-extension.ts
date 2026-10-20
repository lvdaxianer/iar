/**
 * Pi Package 默认入口；完整工厂由同包公共入口提供。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
/**
 * 创建当前阶段可加载的 Pi 扩展入口。
 * @param _pi - Pi 注入的扩展 API
 * @returns 扩展初始化完成的 Promise
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
export default function piExtension(_pi: unknown): void {
  // 当前先保证 Package 入口可解析，完整桥接逻辑在后续任务接入。
}
