/**
 * 提供不依赖运行时 locale 的稳定标识比较。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */

/**
 * 按 Unicode code point 顺序比较两个插件标识。
 *
 * @param left - 左侧待比较标识
 * @param right - 右侧待比较标识
 * @returns 左侧小于、等于或大于右侧时分别返回负数、零或正数
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function compareStableIds(left: string, right: string): number {
  const leftSymbols = Array.from(left);
  const rightSymbols = Array.from(right);
  const commonLength = Math.min(leftSymbols.length, rightSymbols.length);
  for (let index = 0; index < commonLength; index += 1) {
    const leftCode = leftSymbols[index]?.codePointAt(0) ?? 0;
    const rightCode = rightSymbols[index]?.codePointAt(0) ?? 0;
    if (leftCode !== rightCode) return leftCode - rightCode;
  }
  return leftSymbols.length - rightSymbols.length;
}
