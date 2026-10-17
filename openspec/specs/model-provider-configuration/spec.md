# model-provider-configuration Specification

## Purpose
定义模型连接配置与运行时环境变量之间的安全边界，使普通交互模型和 Intent Model 能独立切换 endpoint、API key 与 model ID，同时保持稳定的 provider、审计和路由契约。

## Requirements

### Requirement: Model connection settings support independent environment overrides

The runtime SHALL allow normal interaction profiles and Intent Model profiles to declare independent environment variable names for endpoint, API key, and model ID. A non-empty environment override SHALL take precedence over the profile default. Resolved secrets SHALL NOT be stored in profiles, audit metadata, stable errors, or logs.

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
