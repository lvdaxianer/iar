# Spec Delta

## ADDED Requirements

### Requirement: Providers persist the ordered verified fact history
The persistence SPI and built-in SQLite Provider SHALL save and restore the versioned bounded fact history, source provenance, sequence order and current focus together with the session snapshot, while preserving snapshot revision ordering and event idempotency.

#### Scenario: Restart restores repeated results
- **WHEN** a session with multiple verified records is resumed after process restart
- **THEN** the latest valid snapshot restores every retained record in the same order and does not collapse equal field keys

#### Scenario: Older snapshot cannot erase newer records
- **WHEN** an older snapshot write completes after a newer snapshot containing additional fact records
- **THEN** the older write is rejected or ignored and the newer fact history remains recoverable

#### Scenario: External Provider receives the same contract
- **WHEN** an external Provider implements the declared versioned SPI
- **THEN** it receives and returns the same opaque record IDs, order, provenance and focus semantics without runtime business-specific handling

### Requirement: Recent raw messages remain separate from trusted history
Persistence SHALL store recent message records independently from structured fact records and SHALL restore them only as a bounded, chronological, non-authoritative model input window.

#### Scenario: Resume loads both context sources
- **WHEN** a known session is resumed with a configured recent-message limit
- **THEN** the runtime loads the latest bounded messages alongside the ordered fact history without copying message text into trusted records

#### Scenario: Corrupt message data does not corrupt facts
- **WHEN** a restored message record is invalid or belongs to another session but the structured snapshot is valid
- **THEN** the runtime excludes that message data while preserving the valid fact history and safe session state
