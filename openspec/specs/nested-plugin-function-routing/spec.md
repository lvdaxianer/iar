# nested-plugin-function-routing Specification

## Purpose

让模型在一次受限的 OpenAI-compatible 工具调用中同时提出 Plugin、Function、Operation 和具名参数，并让运行时保留最终的安全、契约和执行控制。

## Requirements

### Requirement: Plugin is the model tool boundary

The runtime SHALL expose one OpenAI-compatible tool per enabled and authorized business Plugin, with the Plugin identity preserved by a runtime-owned mapping.

#### Scenario: Enabled Plugin becomes one tool

- **WHEN** an Agent has several enabled Plugins
- **THEN** the model receives one valid tool for each Plugin and no cross-Plugin flat Function tool list

#### Scenario: Disabled Plugin is absent

- **WHEN** an Agent disables a Plugin
- **THEN** that Plugin tool and all nested Function/Operation candidates are absent from the model request

### Requirement: Nested candidates preserve ownership

Each Plugin tool SHALL describe its bounded Functions and Operations as nested candidates, and every candidate SHALL retain stable Plugin, Function and Operation identifiers.

#### Scenario: Model selects a nested operation

- **WHEN** the model calls a Plugin tool with a nested Function and Operation identity
- **THEN** the runtime can resolve the exact installed registration without searching unrelated Plugins

#### Scenario: Duplicate Function names remain unambiguous

- **WHEN** two Plugins expose Functions with the same Function identifier
- **THEN** the Plugin tool boundary keeps both proposals distinguishable by Plugin ownership

### Requirement: Tool names follow the OpenAI contract

Every projected tool name SHALL contain only ASCII letters, digits, underscore or hyphen and SHALL be at most 64 characters; runtime mappings SHALL preserve the original Plugin identity.

#### Scenario: Invalid source identity is normalized

- **WHEN** a Plugin identifier contains a character not allowed by the model provider
- **THEN** the projected tool uses a deterministic valid name and the runtime resolves it back to the original Plugin

#### Scenario: Tool name collision is rejected

- **WHEN** two projected Plugins would receive the same normalized tool name
- **THEN** registration fails with a stable validation error before model requests are accepted

### Requirement: One route call proposes the complete candidate

The primary route SHALL use at most one model call to propose the Plugin tool, nested Function/Operation and named JSON object arguments for the current message. The runtime SHALL distinguish a model-proposed Operation from an Operation explicitly supported by the current user input or an already verified same-session route. When the Function is identified but no unique Operation is supported, the runtime SHALL return a bounded Operation clarification containing only the registered Operations of that Function and SHALL NOT execute or enter confirmation using a default Operation.

#### Scenario: Query proposal is complete

- **WHEN** a user asks a query handled by an enabled Plugin
- **THEN** the route result contains the selected Plugin, Function, Operation and named arguments from one model call, with no duplicate operation field inside the arguments

#### Scenario: No matching candidate is proposed

- **WHEN** no enabled Plugin tool matches the current message
- **THEN** the runtime returns a bounded clarification or normal response without executing a Function

#### Scenario: Operation is missing from a matched proposal

- **WHEN** a model proposes a Plugin and Function but the current input does not establish a unique outer Operation
- **THEN** the runtime returns a stable operation-missing result, records the allowed operation IDs, asks the user to choose from that Function's bounded Operation catalog, and does not execute the Function

#### Scenario: Model default does not become an Operation

- **WHEN** the model proposes a read or action Operation that is not evidenced by the current message and no verified same-session Operation exists
- **THEN** the runtime treats the Operation as unresolved, does not use the Handler's default, and keeps the selected Plugin/Function identity for the next clarification turn

#### Scenario: Explicit Operation completes the same route

- **WHEN** the user supplies one allowed Operation after an operation clarification
- **THEN** the runtime retains the verified Plugin/Function, merges the named fields from the current and prior turns, and continues through Schema, policy and confirmation validation

### Requirement: Runtime validates the complete proposal

The runtime SHALL treat the model proposal as untrusted and SHALL validate ownership, enabled state, installed input Schema, authorization, policy, confirmation and idempotency before execution. Operation identity SHALL be validated once from the outer route envelope, and any repeated operation value inside arguments SHALL be rejected when it conflicts with the outer value.

#### Scenario: Valid arguments execute the owned registration

- **WHEN** the proposal identifies an enabled Plugin and its installed Function/Operation and its arguments satisfy the installed Schema
- **THEN** only that registration receives the validated arguments

#### Scenario: Swapped or unknown argument placement is rejected

- **WHEN** the proposal has missing, extra, mistyped or semantically invalid named arguments
- **THEN** execution is blocked and the runtime returns a stable clarification or validation result

#### Scenario: Repeated operation conflicts with the route identity

- **WHEN** the outer route operation is `limit` and the nested arguments contain `operation: stats`
- **THEN** the runtime returns an operation-conflict result, does not execute the Function, and preserves both values for safe diagnostics

#### Scenario: Repeated operation is absent

- **WHEN** the outer route operation is valid and the nested arguments do not contain an operation field
- **THEN** the runtime accepts the proposal and supplies the validated outer operation to the installed Function contract without requiring the model to repeat it

### Requirement: Query results use model response generation

When an executed Function returns a query or model response mode, the runtime SHALL pass its bounded result to `response.generate`; action confirmation and UI-only modes MAY skip that call according to the fixed response contract.

#### Scenario: Query result is summarized

- **WHEN** a read/query Function completes successfully
- **THEN** the final user-facing answer is generated from the bounded Function result and current context

#### Scenario: Confirmation result does not generate chat text

- **WHEN** a Function returns a pending confirmation or UI-only result
- **THEN** the runtime preserves the pending state and does not fabricate a model summary

### Requirement: Canonical identifiers drive nested route validation

The runtime SHALL treat the model-proposed `plugin_id`, `function_id` and `operation` from the finite nested tool set as the routing identity, while natural-language semantic fields remain non-authoritative context.

#### Scenario: Natural language maps to a canonical Function

- **WHEN** the user asks “帮我创建一张工单” and the model proposes `ticket.create`
- **THEN** the runtime validates and routes `ticket.create` without requiring `semantic.intent` to equal the natural-language phrase or the Function ID

#### Scenario: Canonical identity is not registered

- **WHEN** the model proposes a Plugin, Function or Operation that is absent from the current enabled registry
- **THEN** the runtime returns a stable rejection or clarification and does not construct or execute an Action

### Requirement: Nested route rejection preserves selected identity

The runtime SHALL retain the validated or attempted Plugin and Function identifiers in rejected route evidence whenever the model returned them.

#### Scenario: Plugin rule rejects a selected Function

- **WHEN** a model proposes `ticket-support-v1` and `ticket.create` but a later rule rejects the proposal
- **THEN** route evidence contains both identifiers and an explicit rejection reason rather than silently replacing the Plugin with an empty value
