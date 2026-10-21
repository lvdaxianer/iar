# Spec Delta

## MODIFIED Requirements

### Requirement: Function results declare a fixed response mode

Every Function Handler result SHALL use a versioned response contract with one of `model`, `direct` or `none`. The mode SHALL be validated before a result is exposed to a user, response model or host UI. For a selected read/query operation, `model` SHALL be the only normal chat response mode; `direct` and `none` SHALL require an explicit non-query exception declared by the Function contract.

#### Scenario: Model mode receives structured data

- **WHEN** a Function returns a successful result whose response mode is `model`
- **THEN** the runtime gives the bounded business output and current structured context to `response.generate` as data, and returns the generated text

#### Scenario: Read query is summarized by the response model

- **WHEN** a selected Function operation is a read/query operation and returns a successful structured result
- **THEN** the runtime sends that result to `response.generate` and does not present the Function output as the final user-facing text

#### Scenario: Direct mode returns validated text

- **WHEN** a non-query Function explicitly declares `direct` with bounded response text
- **THEN** the runtime returns that validated text without invoking `response.generate`

#### Scenario: None mode updates host state only

- **WHEN** a non-query Function explicitly declares `none` for a confirmation, form or UI-only transition
- **THEN** the runtime emits the validated structured state and does not create a normal assistant chat reply

#### Scenario: Invalid query response mode fails closed

- **WHEN** a read/query operation returns `direct` or `none` without an allowed explicit exception
- **THEN** the runtime rejects the result with a stable response-contract validation error and does not expose the invalid content

#### Scenario: Invalid response mode fails closed

- **WHEN** a Handler omits required response fields, uses an unknown mode, attaches text to `none` or exceeds response bounds
- **THEN** the runtime rejects the result with a stable validation error and does not expose the invalid content

## ADDED Requirements

### Requirement: Response policy follows the selected operation

The runtime SHALL resolve the response policy from the selected operation kind and its validated response contract, rather than from the Function name or the model's natural-language output.

#### Scenario: A multi-operation Function performs a query

- **WHEN** a Function exposes both read and side-effecting operations and the selected operation is read/query
- **THEN** the read result follows the model-summary path even if another operation in the same Function requires confirmation

#### Scenario: A side-effect operation completes

- **WHEN** a selected side-effecting operation completes successfully with response mode `model`
- **THEN** the runtime gives the bounded execution result to `response.generate` while preserving the action's executed status

#### Scenario: Confirmation remains outside normal model response

- **WHEN** a side-effecting operation is awaiting confirmation or a UI-only transition returns `none`
- **THEN** the runtime does not invoke `response.generate` for a normal assistant reply
