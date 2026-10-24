# Spec Delta

## MODIFIED Requirements

### Requirement: Models can answer from verified facts without repeating actions

The system SHALL separate semantic intent from a fixed action type and give the model only finite, runtime-filtered Plugin/Function candidates. The action type SHALL be one of `query`, `create`, `update`, `delete`, `transfer`, `execute` or `unknown`, never a business-specific operation. When no Function is selected, the response model SHALL answer from verified facts or ask a bounded clarification and SHALL NOT execute a Function. A verified fact or recent message SHALL not supply a missing object for a new generic query unless the current user message contains a validated historical reference.

#### Scenario: Unspecified generic query does not reuse an old fact

- **WHEN** the session contains a successful prior result and the current user asks to “查询一下” without an object or historical reference
- **THEN** the runtime asks for the query target and does not claim a result from the prior fact or initiate a side effect

#### Scenario: Explicit historical query still uses the fact

- **WHEN** the current user explicitly asks about “刚才那个结果” or another validated historical reference
- **THEN** the response may use only the resolved fact and SHALL not create or repeat the prior action

#### Scenario: Ask for the previous ticket number

- **WHEN** a ticket was successfully created and the user asks for its number
- **THEN** the model can answer using the identifier from that successful event without invoking or confirming a second ticket creation

#### Scenario: Other business results work the same way

- **WHEN** a user asks about a prior successful result in another supported subsystem
- **THEN** the same generic fact and decision mechanism supports answering without a subsystem-specific rule

#### Scenario: A query action is separated from semantic intent

- **WHEN** the user asks for a fact, result, status, progress, count, position or identifier, including a reference to a verified prior result
- **THEN** semantic extraction uses `action=query` or `action=unknown` and does not authorize a side-effecting operation from the historical reference

#### Scenario: Candidate capabilities are filtered before model selection

- **WHEN** a semantic action is available for the current message
- **THEN** the runtime filters candidates by session scope, lifecycle, authorization and declared action types before giving bounded Plugin/Function descriptions to the decision model

#### Scenario: No suitable Function is available

- **WHEN** candidates are absent, incompatible, uncertain or rejected
- **THEN** the runtime skips action preparation and execution and gives the current question, structured context, verified facts and pending state to the response model, which either answers or asks for clarification

#### Scenario: Insufficient or ambiguous evidence

- **WHEN** available facts do not establish the intended result or contain the requested value
- **THEN** the model is instructed to express uncertainty or ask for clarification instead of inventing a value or initiating a side effect

#### Scenario: A genuinely new operation is requested

- **WHEN** a supported new operation is selected
- **THEN** existing authorization, policy and confirmation checks remain in force
