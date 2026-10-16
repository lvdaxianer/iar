/**
 * 实现远程插件 artifact 的规范化、摘要、Ed25519 签名和验证。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { createHash, sign, verify, type KeyObject } from 'node:crypto';
import { validatePluginManifest, type PluginManifest } from '@iar/contracts';
import type { DistributionResult, SignedPluginArtifact, TrustedSigner } from './types.js';

/**
 * 对 JSON-like 值按 key 排序，保证不同语言可复现同一个签名 payload。
 * @param value - 待规范化的 JSON-like 值
 * @returns 稳定的规范化 JSON 文本
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) { /* 数组保持顺序，只递归规范化元素。 */ return `[${value.map(canonicalize).join(',')}]`; }
  if (value && typeof value === 'object') { /* 对象 key 排序，消除跨语言序列化差异。 */
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * 生成不包含 signature 字段的签名 payload。
 * @param input - artifact 的无签名字段
 * @returns 跨语言可复现的规范化 JSON 文本
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function canonicalArtifactPayload(input: Omit<SignedPluginArtifact, 'signature'>): string {
  return canonicalize(input);
}

/**
 * 计算 artifact payload 的 SHA-256 摘要。
 * @param input - artifact 的无签名字段
 * @returns 带 sha256 前缀的摘要
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function artifactDigest(input: Omit<SignedPluginArtifact, 'signature'>): string {
  return `sha256:${createHash('sha256').update(canonicalArtifactPayload(input)).digest('hex')}`;
}

/**
 * 使用 Ed25519 私钥生成签名 artifact。
 * @param input - 待签名的 artifact 元数据
 * @param privateKey - Ed25519 私钥
 * @returns 带 base64 签名的 artifact
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function signArtifact(input: Omit<SignedPluginArtifact, 'signature'>, privateKey: KeyObject | string | Buffer): SignedPluginArtifact {
  if (!hasExactArtifactKeys(input, false)) throw new TypeError('artifact fields are not allowed');
  const payload = Buffer.from(canonicalArtifactPayload(input));
  return { ...structuredClone(input), signature: sign(null, payload, privateKey).toString('base64') };
}

/**
 * 验证 artifact 的结构、Manifest、可信 signer、bundle digest 和签名。
 * @param input - 未信任的 artifact 输入
 * @param trustedSigners - signerKeyId 到可信公钥的映射
 * @returns 已校验 artifact 或稳定拒绝
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function verifyArtifact(input: unknown, trustedSigners: ReadonlyMap<string, TrustedSigner>): DistributionResult<SignedPluginArtifact> {
  try {
    if (!isArtifactShape(input)) return { ok: false, reasonCode: 'artifact_input_invalid' }; // 结构不满足协议时立即拒绝。
    const manifest = validatePluginManifest(input.manifest);
    if (!manifest.ok) return { ok: false, reasonCode: 'manifest_invalid' }; // Manifest 不合法时不触碰 Host。
    if (!/^sha256:[a-f0-9]{64}$/.test(input.bundleDigest)) return { ok: false, reasonCode: 'artifact_digest_mismatch' }; // 摘要格式必须稳定。
    const signer = trustedSigners.get(input.signerKeyId);
    if (!signer) return { ok: false, reasonCode: 'signer_untrusted' }; // 未知 signer 不进入密码学验证。
    if (!verifySignedPayload(input, manifest.value, signer)) return { ok: false, reasonCode: 'signature_invalid' }; // 签名不匹配时 fail-closed。
    return { ok: true, value: { ...structuredClone(input), manifest: manifest.value } };
  } catch {
    // revoked Proxy、异常 getter 和非法 key material 统一隐藏底层异常。
    return { ok: false, reasonCode: 'artifact_input_invalid' };
  }
}

/**
 * 验证签名覆盖的无签名字段，避免 signature 自引用或未知字段混入。
 * @param input - 已通过顶层结构校验的 artifact
 * @param manifest - 已通过 contracts 校验的 Manifest
 * @param signer - 可信 Ed25519 公钥
 * @returns 签名是否有效
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function verifySignedPayload(input: SignedPluginArtifact, manifest: PluginManifest, signer: TrustedSigner): boolean {
  const { signature: _signature, ...unsigned } = input;
  const signature = Buffer.from(input.signature, 'base64');
  // 签名覆盖 Manifest、版本和 bundle digest，任一字段篡改都会失败。
  return verify(null, Buffer.from(canonicalArtifactPayload({ ...unsigned, manifest })), signer, signature);
}

/**
 * 判断未知值是否具备 artifact 的最小外壳。
 * @param value - 未信任的未知输入
 * @returns 是否具备可继续校验的 artifact 外壳
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isArtifactShape(value: unknown): value is SignedPluginArtifact {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && hasExactArtifactKeys(value, true)
    && (value as Record<string, unknown>).artifactVersion === 'v1'
    && typeof (value as Record<string, unknown>).signerKeyId === 'string'
    && typeof (value as Record<string, unknown>).signature === 'string'
    && typeof (value as Record<string, unknown>).bundleDigest === 'string'
    && typeof (value as Record<string, unknown>).manifest === 'object';
}

/**
 * 拒绝 artifact 顶层未知字段，避免私钥、bundle 或控制字段进入签名记录。
 * @param value - 待检查的对象
 * @param withSignature - 是否要求 signature 字段
 * @returns 是否严格匹配允许字段集合
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function hasExactArtifactKeys(value: unknown, withSignature: boolean): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false; // 只接受普通对象外壳。
  const expected = withSignature
    ? ['artifactVersion', 'bundleDigest', 'manifest', 'signature', 'signerKeyId'] // 验证输入必须带 signature。
    : ['artifactVersion', 'bundleDigest', 'manifest', 'signerKeyId']; // 待签名输入不得伪造 signature。
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected.sort()[index]);
}
