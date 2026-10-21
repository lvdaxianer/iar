# Spec Delta

## ADDED Requirements

### Requirement: Model response text may contain Markdown

The response contract SHALL continue to require a valid `iar.response/v1` envelope while allowing the generated `text` field to contain bounded Markdown; Markdown fences SHALL NOT be used to wrap the outer JSON response.

#### Scenario: Markdown is returned in text
- **WHEN** a `model` Function result is sent to `response.generate` and the Agent prompt requests Markdown
- **THEN** the validated response contains Markdown in `text` and remains a valid `iar.response/v1` object

#### Scenario: Direct result remains direct
- **WHEN** a Function returns `direct`
- **THEN** the runtime returns the validated direct text without invoking the response model, regardless of the Agent overall prompt

#### Scenario: None result remains silent
- **WHEN** a Function returns `none`
- **THEN** the runtime does not create a normal assistant chat reply or invoke the response model
