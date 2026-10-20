# Spec Delta

## Purpose

为 Pi 提供一个不修改 Pi 核心即可启用的 IAR 业务路由边界，明确输入处置、会话映射、确认安全和故障降级语义，使两套会话状态能够协同而不互相取代。

## ADDED Requirements

### Requirement: Pi bridge exposes a versioned public contract

IAR SHALL expose a versioned bridge contract containing session open, input, confirmation, cancellation and state operations with stable JSON fields and bounded client-controlled values.

#### Scenario: Bridge session is opened

- **WHEN** a client submits a valid Pi session identifier to the bridge
- **THEN** IAR returns a stable bridge version and an IAR session identifier, reusing the existing mapping when one is active

#### Scenario: Invalid bridge input is rejected

- **WHEN** a client submits an empty, oversized or malformed session identifier or message
- **THEN** IAR returns a stable validation error without invoking intent extraction or action execution

### Requirement: Pi and IAR sessions remain separate authorities

The bridge SHALL associate one Pi session with one IAR behavior session while keeping Pi conversation history and IAR verified facts, workflow state, pending confirmation and events under their respective owners.

#### Scenario: Pi session sends a business request

- **WHEN** the bridge receives input with a mapped Pi session
- **THEN** IAR processes it using the mapped behavior session and does not require Pi to reproduce IAR state in the request

#### Scenario: A mapped session is resumed

- **WHEN** a Pi session opens again with the same mapping key
- **THEN** IAR restores or reuses the same behavior session, and a second independent mapping cannot read its pending action

### Requirement: Input disposition prevents duplicate agent handling

The bridge SHALL return exactly one disposition for each accepted input: `pass_through`, `handled`, `clarification`, or `awaiting_confirmation`.

#### Scenario: IAR has no matching business route

- **WHEN** intent extraction and bounded routing produce `noul` with no pending IAR clarification or verified-fact follow-up
- **THEN** the bridge returns `pass_through` without generating an IAR reply or executing a Plugin

#### Scenario: IAR handles a business request

- **WHEN** IAR executes, clarifies, or waits for confirmation on a matched business route
- **THEN** the bridge returns the corresponding non-pass-through disposition and Pi does not start its Agent turn for that input

### Requirement: Confirmation is authoritative and retry-safe

The bridge SHALL forward confirmation and cancellation to IAR using the mapped session and displayed action identifier; IAR SHALL remain the only authority that can execute or cancel the pending action.

#### Scenario: User confirms a pending action

- **WHEN** Pi submits confirmation for the currently displayed action identifier
- **THEN** IAR validates the pending action and scope before executing it, and a duplicate submission cannot execute a second side effect

#### Scenario: User cancels a pending action

- **WHEN** Pi submits cancellation for the currently displayed action identifier
- **THEN** IAR records the cancellation and does not invoke the action executor

### Requirement: Bridge failures fail closed by default

The Pi integration SHALL treat bridge timeout, unavailable service, invalid bridge responses and authorization failures as handled bridge errors by default, and SHALL never silently pass those inputs to Pi tools or shell execution.

#### Scenario: IAR is unavailable

- **WHEN** the Pi extension cannot complete a bridge request within its configured timeout
- **THEN** it shows a bounded error and handles the input without starting the Pi Agent turn

#### Scenario: Extension-injected input is observed

- **WHEN** Pi emits an input whose source is `extension`
- **THEN** the IAR extension leaves it unchanged and does not recursively call the bridge
