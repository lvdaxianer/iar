/**
 * Pi Package 默认入口；完整工厂由同包公共入口提供。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
import { createIarExtension, type PiExtensionAPI } from './extension.js';

/**
 * 创建可加载的 Pi 默认扩展入口。
 * @param pi - Pi 注入的扩展 API
 * @returns 扩展初始化完成的 Promise
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
export default function piExtension(pi: PiExtensionAPI): Promise<void> {
  return createIarExtension()(pi);
}
