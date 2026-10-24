# Spec Delta

## MODIFIED Requirements

### Requirement: Models can answer from verified facts without repeating actions

When a current message is a factual follow-up to a verified session result and does not request a new side effect, Runtime SHALL normalize the semantic frame to `intent=unknown` and `action=query` before business routing. It SHALL preserve verified references and route the message to context response or bounded clarification without creating a Function or Plugin.

#### Scenario: Model returns a capability-shaped query intent

- **WHEN** verified facts exist and the model returns a query action with a new-looking intent for a question about the previous result
- **THEN** Runtime strips untrusted target identity, normalizes the frame to a context query and does not route or execute the invented Function

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

#### Scenario: Ordinary and streamed context answers agree

- **WHEN** the same verified-fact follow-up is submitted through ordinary and streamed turns
- **THEN** both paths produce the same context-answer disposition, route evidence and absence of execution

#### Scenario: New operation is not downgraded

- **WHEN** the current message explicitly requests a new operation, parameter change, confirmation or cancellation
- **THEN** Runtime preserves the operation frame and sends it through the normal route and safety gates
