# Spec Delta

## Purpose

为 Pi Host 提供可复制、可追踪且不会泄露内部机密的当前会话结构化快照，帮助用户复现路由、耗时和上下文问题。

## ADDED Requirements

### Requirement: Pi Host can copy a versioned safe context snapshot

Pi Host SHALL provide a user-triggered action that copies a versioned JSON snapshot of the current session's safe structured context.

#### Scenario: Snapshot is copied
- **WHEN** the user activates the copy-context action with a current session state
- **THEN** the clipboard receives formatted JSON containing the schema version, session identifier, current route summary, timing summary, pending summary and sanitized structured context

#### Scenario: Snapshot is unavailable
- **WHEN** the user activates the action before a session snapshot is available or the clipboard API fails
- **THEN** the page shows a visible failure message and preserves the rest of the session UI

### Requirement: Context export excludes authority and secrets

The exported snapshot SHALL exclude API keys, credentials, raw model prompts, raw model responses, reasoning content, executable Function input, and any field that grants execution authority.

#### Scenario: Sensitive internal fields exist
- **WHEN** the current runtime contains prompts, credentials, raw model payloads or private execution data
- **THEN** none of those fields appear in the copied JSON

### Requirement: Context export reflects the latest completed state

The copied snapshot SHALL represent the latest validated route, timing and structured state known to the page, and SHALL identify its trace when one exists.

#### Scenario: A new turn completes
- **WHEN** a route or response event updates the current session snapshot
- **THEN** the next copy action contains the new route, timing and trace values rather than stale values from an earlier turn
