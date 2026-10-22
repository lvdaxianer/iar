# Function Call Routing Specification

## Purpose

为已选 Plugin 内的 Function 提供受限、可验证的工具调用和参数提议边界，确保模型只能提出调用，不能扩展 Function、Plugin、权限或执行范围。

## Requirements

### Requirement: Function call output is versioned and bounded

The runtime SHALL expose a versioned `iar.function-call/v1` proposal containing exactly the selected Plugin, Function, Operation, JSON object arguments and bounded confidence metadata. The proposal SHALL be validated before it reaches Action construction or a Handler.

#### Scenario: Valid tool call is normalized

- **WHEN** the Function-call model returns a tool call whose name belongs to the finite tool set and whose arguments are a JSON object
- **THEN** the adapter returns a validated `iar.function-call/v1` proposal with the selected Function and parsed arguments

#### Scenario: Valid nested tool call is normalized

- **WHEN** the model returns a tool call whose name belongs to the finite Plugin tool set and whose arguments contain a valid nested Function/Operation and JSON object parameters
- **THEN** the adapter returns a validated `iar.function-call/v1` proposal with Plugin ownership and parsed named arguments

#### Scenario: Unknown nested identity is rejected

- **WHEN** the model returns an unknown tool, Function or Operation identity
- **THEN** the runtime returns a stable rejected result and does not construct or execute an Action

#### Scenario: Unknown tool is rejected

- **WHEN** the model returns a tool name that is not in the selected Plugin's finite Function tool set
- **THEN** the runtime returns a stable rejected result and does not construct or execute an Action

### Requirement: Function calls are restricted to the selected Plugin

The runtime SHALL build nested Function/Operation candidates only from the current enabled Plugin registration and SHALL reject a proposal whose Plugin, Function or Operation ownership does not match that registration.

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

#### Scenario: Invalid or misplaced arguments require clarification

- **WHEN** required arguments are missing, types are invalid, additional properties are present, or values are assigned to the wrong named field
- **THEN** the runtime returns a bounded clarification or stable validation failure and does not execute the Function

### Requirement: Function calling never grants execution authority

The runtime SHALL perform authorization, capability, policy, confirmation and idempotency checks after validating a Function-call proposal. A tool call response SHALL never directly execute a Function.

#### Scenario: High-risk tool call waits for confirmation

- **WHEN** a valid Function-call proposal targets an operation requiring confirmation
- **THEN** the runtime stores the validated pending Action and does not invoke the Handler or response model until confirmation

#### Scenario: High-risk nested tool call waits for confirmation

- **WHEN** a valid nested proposal targets an operation requiring confirmation
- **THEN** the runtime stores the validated pending Action and does not invoke the Handler or response model until confirmation

#### Scenario: Query tool result is summarized

- **WHEN** a valid read/query Function-call proposal executes successfully with response mode `model`
- **THEN** the bounded Function result is passed to `response.generate` and the raw tool result is not presented as the final chat response

### Requirement: Function identity and arguments are separate contracts

The runtime SHALL validate the canonical Function identity independently from the named argument object, and SHALL use only the installed Function input Schema to construct an Action. The route envelope's outer Operation SHALL remain the canonical operation identity; the model SHALL NOT be required to repeat it inside the argument object.

#### Scenario: Canonical Function with valid named arguments

- **WHEN** the model returns `ticket.create` and an object whose fields satisfy the installed input Schema
- **THEN** the runtime constructs the Action with those named arguments and does not remap them by position or natural-language labels

#### Scenario: Correct values assigned to the wrong fields

- **WHEN** the model returns valid-looking values under the wrong named fields
- **THEN** Schema and semantic validation reject the proposal or request clarification before execution

#### Scenario: Outer operation is injected into the installed contract

- **WHEN** the route envelope contains a validated operation and the named arguments contain only business fields
- **THEN** the runtime supplies the validated operation to the installed Function contract without asking the model to duplicate it

#### Scenario: Conflicting repeated operation is rejected

- **WHEN** the route envelope and the named arguments contain different operation values
- **THEN** the runtime returns a stable operation-conflict validation result and does not construct or execute an Action

### Requirement: Function-call contract failures are classified

The runtime SHALL classify invalid model proposals with stable reason codes and SHALL preserve the safe expected and actual identity values needed for diagnosis.

#### Scenario: Operation is missing

- **WHEN** a matched Function proposal has no usable outer operation
- **THEN** the runtime returns `operation_missing` with the bounded allowed operation IDs and does not execute the Function

#### Scenario: Operation is not allowed

- **WHEN** the proposal operation is not registered for the selected Plugin and Function
- **THEN** the runtime returns `operation_not_allowed` with the selected identity and bounded allowed operation IDs

#### Scenario: Operation values conflict

- **WHEN** the outer operation and a repeated argument operation differ
- **THEN** the runtime returns `operation_conflict` with the outer and nested values and blocks execution

#### Scenario: Contract failure is observable without raw model data

- **WHEN** any of the preceding contract failures occurs
- **THEN** the runtime emits a trace-correlated diagnostic containing stage, model role, expected values, actual values and decision, while omitting the raw prompt, full model response and credentials

### Requirement: Model identity remains advisory

The runtime SHALL never treat a valid Function ID as execution authority; authorization, capability, policy, confirmation and idempotency checks SHALL remain mandatory after identity validation.

#### Scenario: Valid ID targets a high-risk action

- **WHEN** the model returns a valid `ticket.create` proposal for an operation requiring confirmation
- **THEN** the runtime stores a validated pending Action and does not invoke the Handler before confirmation
