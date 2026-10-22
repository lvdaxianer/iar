# Spec Delta

## MODIFIED Requirements

### Requirement: Intent extraction does not expose reasoning

Semantic extraction and routing model calls SHALL disable reasoning output and SHALL expose only their validated structured decision results to the runtime and host. The provider request sent to an OpenAI-compatible model MUST carry the explicit disabled-thinking option for these roles, rather than relying on an upstream model default.

#### Scenario: Intent extraction completes
- **WHEN** the intent model returns a semantic decision
- **THEN** no reasoning event is sent to the host and only the validated decision and timing metadata are available

#### Scenario: Structured extraction request is inspected
- **WHEN** a `semantic.extract`, `function.call`, `function.select`, `plugin.select`, or `route.propose` request is sent to an OpenAI-compatible provider
- **THEN** the request explicitly disables thinking and does not depend on provider defaults

#### Scenario: Final response keeps independent reasoning behavior
- **WHEN** a `response.generate` request is sent to a provider configured for native reasoning
- **THEN** the response role keeps its configured reasoning behavior and is not affected by extraction-role suppression
