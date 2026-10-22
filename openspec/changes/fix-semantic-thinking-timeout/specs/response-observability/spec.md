# Spec Delta

## ADDED Requirements

### Requirement: Bridge client timeout is bounded and configurable

The Pi Bridge client SHALL accept an optional environment-based request timeout, use a documented default when it is absent, reject non-positive or excessive values, and classify expiry as a bridge timeout without exposing upstream payloads.

#### Scenario: Configured timeout is used
- **WHEN** the host starts with a valid Bridge timeout environment value
- **THEN** every Bridge HTTP request uses that bounded timeout

#### Scenario: Missing timeout uses the default
- **WHEN** no Bridge timeout environment value is configured
- **THEN** the client uses its documented default and preserves existing request behavior

#### Scenario: Invalid timeout fails safely
- **WHEN** the timeout value is malformed, non-positive, or exceeds the maximum
- **THEN** startup or client construction rejects the configuration with a stable configuration error and does not make a Bridge request

#### Scenario: Bridge expiry is distinguished from model failure
- **WHEN** the client-side Bridge deadline expires before an HTTP response is received
- **THEN** the host receives the stable Bridge-timeout classification, while a server-returned model failure keeps its model-failure classification
