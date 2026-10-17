# Spec Delta

## ADDED Requirements

### Requirement: Intent Model uses the configured environment-backed Provider

The Intent Model decision adapter SHALL be executable through an explicitly injected provider whose endpoint, API key, and model ID can be independently overridden by environment variables. The provider SHALL preserve the fixed Intent Prompt and shared `iar.decision/v1` validation boundary.

#### Scenario: Environment-backed Intent Model remains JEV-compatible

- **WHEN** the resolver selects Intent Model because no JEV primary exists and the Intent Model environment variables are configured
- **THEN** the provider sends the versioned Intent Prompt and returns the same validated `DecisionResult` shape used by JEV

#### Scenario: Provider configuration does not change backend precedence

- **WHEN** both JEV and environment-backed Intent Model profiles are configured
- **THEN** the resolver selects JEV and does not invoke the Intent Model provider
