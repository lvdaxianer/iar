# Proposal

## Why

The single real-model session on port 8878 exposed two runtime context defects:
natural-language cancellation was blocked by an existing pending action, and a
post-compaction historical status question could be reclassified as a new
side-effecting action. Both defects are in session safety and context recovery,
not in plugin business behavior.

## What Changes

- Recognize an explicit natural-language withdrawal while a confirmation or
  parameter collection is pending, clear only that pending workflow state, and
  record a cancellation without invoking a handler.
- Preserve the verified action/result distinction across compaction so a
  historical status question cannot become a new action solely because the
  response model omitted context fields.
- Add focused scripted regressions and rerun all 50 attached scenarios through
  one unchanged real Pi/IAR session on port 8878.
- Do not change plugin handlers, fixture business data, public HTTP fields, or
  authorization/confirmation policy.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `continuation-recovery`: pending cancellation and post-compaction historical
  references must remain non-executable and target the verified prior result.
- `structured-model-context`: compaction and current-turn classification must
  preserve verified facts and distinguish a status query from a new action.

## Impact

Affected runtime session continuation/clarification and compaction boundaries,
plus focused integration tests and the real-model verification driver. No plugin
business module or external API contract is changed.
