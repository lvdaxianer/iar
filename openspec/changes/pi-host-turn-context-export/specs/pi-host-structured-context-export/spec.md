# Spec Delta

## MODIFIED Requirements

### Requirement: Pi Host can copy a versioned safe context snapshot

Pi Host SHALL provide a user-triggered action that copies a versioned JSON snapshot of the current session's safe structured context. The snapshot SHALL include the current `structuredContext` projection and `workflowState` projection, including the bounded ordered context already maintained for completed turns and verified facts.

#### Scenario: Snapshot is copied
- **WHEN** the user activates the copy-context action with a current session state
- **THEN** the clipboard receives formatted JSON containing the schema version, session identifier, current route summary, timing summary, pending summary, structured context projection and workflow state projection

#### Scenario: Snapshot is unavailable
- **WHEN** the user activates the action before a session snapshot is available or the clipboard API fails
- **THEN** the page shows a visible failure message and preserves the rest of the session UI

### Requirement: Context export reflects the latest completed state

The copied snapshot SHALL represent the latest validated route, timing, structured context and workflow state known to the page, SHALL preserve the current session's bounded ordered context, and SHALL identify its trace when one exists.

#### Scenario: A new turn completes
- **WHEN** a route or response event updates the current session snapshot
- **THEN** the next copy action contains the new route, timing, structured context, workflow state and trace values rather than stale values from an earlier turn

#### Scenario: A session contains multiple completed turns
- **WHEN** the user copies the snapshot after multiple turns in the same session
- **THEN** the exported structured context contains the bounded ordered turn and verified-fact context available to the current session without switching sessions
