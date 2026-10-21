# Runtime package migration

## Final package map

| Package | Responsibility | Replaceable boundary |
| --- | --- | --- |
| `@iar/contracts` | JSON-safe schemas, versions and stable errors | contract/version boundary |
| `@iar/plugin` | Plugin/Function author SDK | authoring boundary |
| `@iar/plugins` | PluginHost, FunctionRegistry and lifecycle | plugin lifecycle boundary |
| `@iar/runtime` | standalone intent/action runtime, routing, execution, observability and session state | runtime core |
| `@iar/subscriptions` | Hook and StateEvent subscription contracts | event boundary |
| `@iar/storage` | persistence SPI, SQLite runtime and storage loader | persistence boundary |
| `@iar/control-plane` | tenant authorization and plugin distribution | management boundary |
| `@iar/cli` | local operator CLI | product entry |
| `@iar/pi-bridge` | Pi protocol/client/extension adapter | Pi host boundary |
| `@iar/adapters-fastify` | HTTP transport and response mapping | HTTP boundary |
| `@iar/adapters-service` | tenant-scoped Service API | service boundary |
| `@iar/adapters-sidecar` | sidecar transport | process boundary |
| `@iar/adapters-postgres` | PostgreSQL implementation of `@iar/storage` | database adapter |
| `@iar/adapters-temporal` | durable execution implementation using runtime contracts | durable execution adapter |
| `@iar/adapters-executors` | worker/sidecar/container execution | isolation adapter |

The runtime implementation is organized as:

```text
packages/runtime/src/
├── bootstrap/       # createIarRuntime; createIarAgent is deprecated alias
├── intent/
│   ├── decision/    # DecisionProvider, model gateway and validation
│   └── rules/       # bounded candidate/rule evaluation
├── execution/       # PolicyGate, LocalWorkflow, Action execution and event log
├── observability/   # redaction, recorder and system logging plugin
├── session/         # BehaviorContext, replay, compaction and idempotency
├── routing.ts       # Function-first and Plugin-first bounded routing
└── index.ts         # public root entry
```

`@iar/runtime` does not import Pi, Fastify, PostgreSQL, Temporal or container code. It depends only on contracts, plugin lifecycle and shared subscriptions. `@iar/pi-bridge` transports input/result and does not own runtime state. `@iar/storage` and `@iar/adapters-postgres` remain replaceable persistence implementations.

## Migration table

| Previous package | New location/API | Action |
| --- | --- | --- |
| `@iar/agent` | `@iar/runtime` → `createIarRuntime` | change import; `createIarAgent` remains deprecated temporarily |
| `@iar/decision` | `@iar/runtime` public exports; `runtime/src/intent/decision` internally | change import |
| `@iar/rule-engine` | `@iar/runtime` public exports; `runtime/src/intent/rules` internally | change import |
| `@iar/workflow` | `@iar/runtime` public exports; `runtime/src/execution` internally | change import |
| `@iar/observability` | `@iar/runtime` public exports; `runtime/src/observability` internally | change import |

Example:

```ts
import { createIarRuntime, type AsyncDecisionAdapter } from '@iar/runtime';
import { ticketPlugin } from './ticket-plugin.js';

const decisionProvider = {
  decide: async () => ({
    ok: false,
    error: { code: 'model.no_profile', message: '决策模型 backend 未配置', retryable: false, details: {} },
    audit: [],
    events: [],
  }),
} satisfies AsyncDecisionAdapter;

const runtime = createIarRuntime({ plugins: [ticketPlugin], decisionProvider });
```

Do not import `src` or `dist` files from another package. Do not add Pi, HTTP, database or Temporal dependencies to `@iar/runtime`; install the adapter explicitly at the application boundary.
