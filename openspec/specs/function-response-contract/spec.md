# Function Response Contract

为 IAR Function Handler 提供固定、版本化且可审计的结果回复协议，使运行时能够区分交给模型汇总、直接返回和只更新结构化状态的结果。

## Requirements

### Requirement: Function results declare a fixed response mode

Every Function Handler result SHALL use a versioned response contract with one of `model`, `direct` or `none`. The mode SHALL be validated before a result is exposed to a user, response model or host UI.

#### Scenario: Model mode receives structured data

- **WHEN** a Function returns a successful result whose response mode is `model`
- **THEN** the runtime gives the bounded business output and current structured context to `response.generate` as data, and returns the generated text

#### Scenario: Direct mode returns validated text

- **WHEN** a Function returns `direct` with bounded response text
- **THEN** the runtime returns that validated text without invoking `response.generate`

#### Scenario: None mode updates host state only

- **WHEN** a Function returns `none` for a confirmation, form or UI-only transition
- **THEN** the runtime emits the validated structured state and does not create a normal assistant chat reply

#### Scenario: Invalid response mode fails closed

- **WHEN** a Handler omits required response fields, uses an unknown mode, attaches text to `none` or exceeds response bounds
- **THEN** the runtime rejects the result with a stable validation error and does not expose the invalid content
