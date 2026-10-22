# model-provider-configuration Specification

## Purpose
定义模型连接配置与运行时环境变量之间的安全边界，使普通交互模型和 Intent Model 能独立切换 endpoint、API key 与 model ID，同时保持稳定的 provider、审计和路由契约。

## Requirements

### Requirement: Model connection settings support independent environment overrides

The runtime SHALL allow independent profiles for `semantic.extract`, `function.call`, and `response.generate`. `semantic.extract` and `response.generate` use the normal interaction model environment mapping; `function.call` resolves JEV first and uses the Intent Model environment mapping only when no valid JEV primary profile is configured. Resolved secrets remain absent from profiles, audit metadata, stable errors and logs.

#### Scenario: Function-call stage falls back when JEV is absent

- **WHEN** no valid JEV `function.call` profile exists and the Intent Model endpoint/key/model variables are configured
- **THEN** the runtime invokes the Intent Model and preserves the same validated function-call output contract

#### Scenario: Missing both Function-call backends fails safely

- **WHEN** neither JEV nor Intent Model has a valid `function.call` profile
- **THEN** the runtime returns a stable model configuration failure without invoking a mock or executing a Function

#### Scenario: Normal interaction model uses its environment overrides

- **WHEN** a normal interaction profile declares endpoint, API key, and model ID environment variables and all three variables are set
- **THEN** the normal interaction provider sends the request to that endpoint using that key and model ID

#### Scenario: Intent Model uses an independent environment set

- **WHEN** an Intent Model profile declares its own endpoint, API key, and model ID environment variables
- **THEN** the Intent Model provider uses those values without reading or overriding the normal interaction model variables

#### Scenario: Missing environment override falls back to a safe profile default

- **WHEN** an optional model ID override is unset and the profile has a non-secret model ID
- **THEN** the provider uses the profile model ID

#### Scenario: Missing required endpoint or key fails closed

- **WHEN** a provider has no endpoint or API key after applying its environment mapping and provider defaults
- **THEN** the call returns the existing stable provider-unavailable failure without making a network request

#### Scenario: Secrets never cross the public boundary

- **WHEN** a provider call succeeds or fails
- **THEN** the API key and resolved endpoint are absent from public results, audit metadata, stable errors, and logs
