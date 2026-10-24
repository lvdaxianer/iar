# Spec Delta

## MODIFIED Requirements

### Requirement: Pending workflows accept only explicit safe transitions

When a confirmation or parameter collection is pending, Runtime SHALL inspect
the current turn for an explicit cancellation or a valid continuation before
returning the pending guard. A cancellation SHALL clear the pending workflow,
record the cancellation event, and never invoke the pending Function. Ambiguous
text SHALL remain pending and SHALL require an explicit confirmation or
cancellation action.

#### Scenario: Natural-language withdrawal cancels a pending ticket

- **WHEN** a ticket-create action is awaiting confirmation and the user says
  “算了，不建了”
- **THEN** Runtime clears the pending action, reports cancellation, and the
  ticket handler is not called

#### Scenario: Unrelated text cannot cancel a pending action

- **WHEN** an action is awaiting confirmation and the user sends a new topic or
  an ambiguous acknowledgement such as “好的”
- **THEN** Runtime leaves the pending action intact and does not execute or
  silently discard it

#### Scenario: Explicit confirmation remains separate

- **WHEN** an action is awaiting confirmation and the user sends “确认”
- **THEN** Runtime applies confirmation only to the pending action and invokes
  the existing confirmation path exactly once

### Requirement: Historical status follow-up remains read-only after compaction

After valid compaction, a current question that explicitly refers to a verified
prior result or its status SHALL resolve through the validated fact/reference
path when it contains no fresh side-effecting parameter. It SHALL NOT create a
new pending action or invoke a handler merely because the semantic frame is
incomplete.

#### Scenario: Compacted adjustment status is not a new adjustment

- **WHEN** a limit adjustment has been confirmed, the session is compacted, and
  the user asks “刚才那个调整生效了吗？”
- **THEN** Runtime answers from the verified adjustment fact or asks a bounded
  read-only clarification, without creating a new limit action
