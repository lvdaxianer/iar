# Function Call Routing Specification

## Purpose

为已选 Plugin 内的 Function 提供受限、可验证的工具调用和参数提议边界，确保模型只能提出调用，不能扩展 Function、Plugin、权限或执行范围。

## ADDED Requirements

### Requirement: Function call output is versioned and bounded

The runtime SHALL expose a versioned `iar.function-call/v1` proposal containing exactly the selected Plugin, Function, Operation, JSON object arguments and bounded confidence metadata. The proposal SHALL be validated before it reaches Action construction or a Handler.

#### Scenario: Valid tool call is normalized

- **WHEN** the Function-call model returns a tool call whose name belongs to the finite tool set and whose arguments are a JSON object
- **THEN** the adapter returns a validated `iar.function-call/v1` proposal with the selected Function and parsed arguments

#### Scenario: Unknown tool is rejected

- **WHEN** the model returns a tool name that is not in the selected Plugin's finite Function tool set
- **THEN** the runtime returns a stable rejected result and does not construct or execute an Action

### Requirement: Function calls are restricted to the selected Plugin

The runtime SHALL build Function tools only from the current enabled Plugin record and SHALL reject a proposal whose Plugin or Function ownership does not match that record.

#### Scenario: Cross-Plugin Function proposal is rejected

- **WHEN** the first stage selected Plugin `plugin-a` but the Function-call model proposes a Function owned by `plugin-b`
- **THEN** the runtime rejects the proposal before parameter validation and execution

#### Scenario: Plugin changes between stages

- **WHEN** the selected Plugin is disabled, unloaded or no longer authorized before Function-call execution
- **THEN** the runtime re-resolves the Plugin and returns a stable unavailable/unauthorized result without invoking the Handler

### Requirement: Function-call arguments use the installed input Schema

The runtime SHALL validate Function-call arguments against the installed Function input Schema, reject missing or unknown fields, and SHALL NOT accept model-supplied schema or capability changes.

#### Scenario: Valid arguments become Action input

- **WHEN** the proposal names an owned Function and its arguments satisfy the installed input Schema
- **THEN** the validated arguments are the only input used to construct the Action

#### Scenario: Invalid arguments require clarification

- **WHEN** required arguments are missing, types are invalid, or additional properties are present
- **THEN** the runtime returns a bounded clarification or stable validation failure and does not execute the Function

### Requirement: Function calling never grants execution authority

The runtime SHALL perform authorization, capability, policy, confirmation and idempotency checks after validating a Function-call proposal. A tool call response SHALL never directly execute a Function.

#### Scenario: High-risk tool call waits for confirmation

- **WHEN** a valid Function-call proposal targets an operation requiring confirmation
- **THEN** the runtime stores the validated pending Action and does not invoke the Handler or response model until confirmation

#### Scenario: Query tool result is summarized

- **WHEN** a valid read/query Function-call proposal executes successfully with response mode `model`
- **THEN** the bounded Function result is passed to `response.generate` and the raw tool result is not presented as the final chat response
