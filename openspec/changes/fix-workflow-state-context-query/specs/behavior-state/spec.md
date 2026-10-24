# Spec Delta

## ADDED Requirements

### Requirement: BehaviorContext distinguishes active workflow from terminal outcome

BehaviorContext SHALL expose the active workflow position separately from the latest completed, cancelled or failed outcome. Terminal outcomes SHALL remain available for fact history, diagnostics and recovery, but SHALL NOT restrict a new turn to the previous workflow's transition subset.

#### Scenario: Completed workflow accepts a new input

- **WHEN** a workflow has completed and the next message starts a new request or asks about a verified result
- **THEN** Runtime treats the input as a new semantic decision or context answer, without returning `workflow_transition_invalid` solely because the previous outcome was completed

#### Scenario: Active confirmation remains constrained

- **WHEN** a workflow is awaiting confirmation and the model returns an execution-like event without a matching current confirmation
- **THEN** Runtime rejects the event and does not execute the pending action

#### Scenario: Terminal outcome does not grant execution

- **WHEN** a completed, cancelled or failed workflow receives a model event
- **THEN** Runtime may continue to semantic routing, but execution still requires a newly validated Function/Plugin route, Schema, authorization, policy, idempotency and confirmation result
