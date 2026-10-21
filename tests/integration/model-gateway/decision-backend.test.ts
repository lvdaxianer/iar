/*
 * 验证 Task 1.2 的决策后端解析边界。
 * resolver 必须按 JEV → Intent Model 顺序选择 primary backend。
 * legacy selection profile 缺失 decisionBackend 时兼容为 JEV，且不改写 profile。
 * fallback profile 不得被当作 primary 返回。
 * 没有可用 backend 时只暴露稳定的 model.no_profile 错误。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { DecisionBackendResolutionError, DecisionBackendResolver, ModelProfileRegistry, loadModelProfiles } from '@iar/runtime';

/**
 * 读取版本化模型配置文本。
 * @returns 配置文件内容
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function configText(): string {
  return readFileSync(join(process.cwd(), 'config', 'models.yaml'), 'utf8');
}

/**
 * 复制指定选择 role 的 profile 配置，供 resolver focused tests 组装场景。
 * @param role - 要测试的选择 role
 * @returns 可安全修改的 profile 配置副本
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function selectionProfileConfig(role: 'function.select' | 'plugin.select'): Array<Record<string, unknown>> {
  const parsed = JSON.parse(configText()) as { profiles: Array<Record<string, unknown>> };
  return parsed.profiles.filter((profile) => (profile.profileId === `${role === 'function.select' ? 'function' : 'plugin'}-decision-primary` || profile.profileId === `${role === 'function.select' ? 'function' : 'plugin'}-decision-fallback`) && profile.role === role).map((profile) => ({ ...profile }));
}

/* 同一 role 同时有两个 primary 时，resolver 只能返回 JEV。 */
test('prefers the JEV primary when a role has both decision backends', () => {
  const jevProfiles = selectionProfileConfig('function.select');
  const jevPrimary = jevProfiles.find((profile) => profile.fallbackProfileId);
  const jevFallback = jevProfiles.find((profile) => !profile.fallbackProfileId);
  assert.ok(jevPrimary);
  assert.ok(jevFallback);
  jevPrimary.decisionBackend = 'jev';
  jevFallback.decisionBackend = 'jev';
  const intentPrimary = { ...jevPrimary, profileId: 'function-intent-primary', modelId: 'function-intent', decisionBackend: 'intent-model', fallbackProfileId: 'function-intent-fallback' };
  const intentFallback = { ...jevFallback, profileId: 'function-intent-fallback', modelId: 'function-intent-fallback', decisionBackend: 'intent-model' };
  const registry = new ModelProfileRegistry(loadModelProfiles({ configVersion: 'iar.models/v1', profiles: [jevFallback, jevPrimary, intentFallback, intentPrimary] }));

  const resolution = new DecisionBackendResolver(registry).resolve('function.select');

  assert.deepEqual(resolution, { role: 'function.select', backend: 'jev', profileId: String(jevPrimary.profileId) });
});

/* JEV primary 缺失时，resolver 才能选择 Intent Model primary。 */
test('resolves the Intent Model primary when JEV is absent', () => {
  const profiles = selectionProfileConfig('function.select');
  profiles.forEach((profile) => { profile.decisionBackend = 'intent-model'; });
  const registry = new ModelProfileRegistry(loadModelProfiles({ configVersion: 'iar.models/v1', profiles: [...profiles].reverse() }));

  const resolution = new DecisionBackendResolver(registry).resolve('function.select');

  assert.equal(resolution.backend, 'intent-model');
  assert.equal(resolution.profileId, 'function-decision-primary');
});

/* 没有任何 selection primary 时，对外只暴露稳定的 model.no_profile。 */
test('throws a stable model.no_profile error when no backend primary exists', () => {
  const profiles = loadModelProfiles(configText()).filter((profile) => profile.role === 'semantic.extract');

  assert.throws(
    () => new DecisionBackendResolver(new ModelProfileRegistry(profiles)).resolve('function.select'),
    (error: unknown) => {
      assert.ok(error instanceof DecisionBackendResolutionError);
      assert.equal(error.code, 'model.no_profile');
      assert.equal(error.message, '决策 role 未配置可用 backend: function.select');
      return true;
    }
  );
});

/* 完全缺失 decisionBackend 的旧 selection profile 按兼容 JEV 解析。 */
test('resolves legacy selection profiles as JEV without rewriting profile fields', () => {
  const profiles = selectionProfileConfig('function.select');
  const primary = profiles.find((profile) => profile.profileId === 'function-decision-primary');
  const fallback = profiles.find((profile) => profile.profileId === 'function-decision-fallback');
  assert.ok(primary);
  assert.ok(fallback);
  delete primary.decisionBackend;
  delete fallback.decisionBackend;
  const registry = new ModelProfileRegistry(loadModelProfiles({ configVersion: 'iar.models/v1', profiles: [fallback, primary] }));

  const resolution = new DecisionBackendResolver(registry).resolve('function.select');

  assert.deepEqual(resolution, { role: 'function.select', backend: 'jev', profileId: 'function-decision-primary' });
  assert.equal(Object.hasOwn(registry.get('function-decision-primary') ?? {}, 'decisionBackend'), false);
});

/* fallback 排在 primary 前面时，resolver 仍按关系图解析 primary。 */
test('does not resolve a fallback profile as the backend primary', () => {
  const profiles = selectionProfileConfig('plugin.select');
  const primary = profiles.find((profile) => profile.profileId === 'plugin-decision-primary');
  const fallback = profiles.find((profile) => profile.profileId === 'plugin-decision-fallback');
  assert.ok(primary);
  assert.ok(fallback);
  primary.decisionBackend = 'jev';
  fallback.decisionBackend = 'jev';
  const registry = new ModelProfileRegistry(loadModelProfiles({ configVersion: 'iar.models/v1', profiles: [fallback, primary] }));

  const resolution = new DecisionBackendResolver(registry).resolve('plugin.select');

  assert.equal(resolution.backend, 'jev');
  assert.equal(resolution.profileId, 'plugin-decision-primary');
});
