/**
 * 提供 Phase 2 `test1` 停止服务验收场景的共享路由夹具。
 * 夹具的事实、规则、宿主和 provider 都保持在内存边界内。
 * Function 和 Plugin provider 都只能返回当前请求中的有限 candidateId。
 * Manifest 能力由 PluginHost 提供，测试 helper 不自行授予能力。
 * route result 只描述选择，不代表 Action 已经执行。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FunctionPluginManifest } from '@iar/contracts';
import { SCHEMA_VERSIONS } from '@iar/contracts';
import { MockDecisionProvider, type DecisionRequest } from '@iar/decision';
import { PluginHost } from '@iar/plugin-host';
import { TwoStageRouter, type RouteRequest, type RouteResult } from '@iar/runtime';
import { facts, functionRule, pluginRule } from './rule-engine-fixtures.js';

/** 三个待处理的 DIP 服务，首个服务固定为 `test1`。 */
export const DIP_SERVICES = ['test1', 'test2', 'test3'] as const;

/** 路由验收场景的 provider 请求和宿主观察数据。 */
export type StopRouteScenario = {
  request: RouteRequest;
  functionCalls: DecisionRequest[];
  pluginCalls: DecisionRequest[];
};

/**
 * 读取 Phase 1 已验证的 DIP stop Manifest。
 * @returns 可安装的 FunctionPluginManifest
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function loadManifest(): FunctionPluginManifest {
  const path = join(process.cwd(), 'tests', 'contract', 'fixtures', 'valid-plugin-manifest.json');
  return JSON.parse(readFileSync(path, 'utf8')) as FunctionPluginManifest;
}

/**
 * 创建只有一个已授权 DIP stop 插件的内存宿主。
 * @returns 已安装且启用的 PluginHost
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function createHost(): PluginHost {
  const host = new PluginHost({ functionIds: ['dip.service.stop'] });
  const manifest = loadManifest();
  assertInstall(host.install(manifest));
  assertInstall(host.enable(manifest.pluginId));
  return host;
}

/**
 * 创建将 provider 输出限制在当前候选集合的确定性 Mock。
 * @param calls - 收集本阶段请求
 * @returns 受统一 Decision 校验保护的 provider
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function provider(calls: DecisionRequest[]): MockDecisionProvider {
  return new MockDecisionProvider((request) => {
    calls.push(request);
    return {
      schemaVersion: SCHEMA_VERSIONS.decision,
      decisionType: request.decisionType,
      decisionVersion: request.decisionVersion,
      status: 'choice',
      choice: request.candidates[0]?.candidateId,
      score: 0.99,
      reasonCode: 'fixture.choice',
      candidateIds: request.candidates.map((candidate) => candidate.candidateId)
    };
  });
}

/**
 * 创建列出三个 DIP 服务并停止首个服务的两阶段路由输入。
 * @returns 带有限 Function/Plugin 候选和授权上下文的场景
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function createStopRouteScenario(): StopRouteScenario {
  const functionCalls: DecisionRequest[] = [];
  const pluginCalls: DecisionRequest[] = [];
  const serviceFacts = { ...facts, services: DIP_SERVICES.map((id) => ({ id, type: 'dip.service' })) };
  return {
    functionCalls,
    pluginCalls,
    request: {
      facts: { ...serviceFacts, subject: { type: 'dip.service', id: DIP_SERVICES[0], status: 'resolved', source: 'event' } },
      tenantId: 'tenant-a',
      actorId: 'actor-a',
      environment: 'prod',
      functionRules: [functionRule('dip.service.stop', { condition: { field: 'semantic.intent', operator: 'equals', value: 'service.stop' } })],
      pluginRules: [pluginRule('dip-api-stop-v1', { condition: { field: 'semantic.intent', operator: 'equals', value: 'service.stop' } }, { requiredCapabilities: ['dip.service.write'] })],
      pluginHost: createHost(),
      functionProvider: provider(functionCalls),
      pluginProvider: provider(pluginCalls),
      authorizePlugin: () => true
    }
  };
}

/**
 * 执行一次确定性的 Function-first 路由。
 * @param scenario - 路由验收场景
 * @returns 带两阶段决策证据的路由结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function routeStopService(scenario: StopRouteScenario = createStopRouteScenario()): RouteResult {
  return new TwoStageRouter().route(scenario.request);
}

/**
 * 断言宿主操作没有返回错误。
 * @param result - PluginHost 操作结果
 * @returns 无返回值，失败时抛出夹具初始化错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertInstall(result: { ok: boolean }): void {
  if (!result.ok) throw new Error('Phase 2 stop-service fixture PluginHost 初始化失败');
}
