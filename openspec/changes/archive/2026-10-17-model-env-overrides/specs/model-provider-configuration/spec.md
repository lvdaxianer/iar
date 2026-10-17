# Spec Delta

## ADDED Requirements

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
