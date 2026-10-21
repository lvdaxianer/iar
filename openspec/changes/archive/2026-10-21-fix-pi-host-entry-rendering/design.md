# Design

## Context

The Pi host session stores entries as `{ customType, data }` and the Pi host
server forwards that object unchanged through the SSE `entry` event. The demo
page's renderer consumes only the inner IAR payload, so the event boundary must
unwrap the envelope before rendering.

## Goals / Non-Goals

**Goals:**

- Preserve the existing backend entry envelope and event stream.
- Render only validated `iar-bridge` payloads.
- Keep malformed or unrelated events isolated from the active chat flow.

**Non-Goals:**

- Do not change IAR intent recognition, plugin/function routing, confirmation,
  Pi delegation, or session ownership.
- Do not change the public Pi host SSE envelope.

## Decisions

The browser event handler will parse the SSE JSON, require `customType` to be
`iar-bridge`, require `data` to be an object, and pass the validated envelope to
the existing `renderEntry` function. The renderer then reads the inner `data`
payload, keeping the transport envelope and display payload explicit while
preventing unrelated event types from being interpreted as IAR entries.

A source-level regression test will verify this inline page contract. A full
browser harness would add unnecessary runtime dependencies for a static demo
page, while the existing Pi host integration tests already verify the backend
envelope and route behavior.

## Risks / Trade-offs

- [Risk] A future entry type may be silently ignored by this page. →
  Mitigation: the page is specifically the IAR bridge demo, and the explicit
  type check prevents misleading rendering.
- [Risk] A malformed SSE payload could throw during parsing. → Mitigation:
  retain the existing stream boundary and validate the parsed envelope before
  calling the renderer; invalid JSON remains handled by the browser event
  source without changing chat submission state.

## Migration Plan

No migration is required. Refreshing the Pi host demo serves the corrected
inline page; the backend protocol remains compatible.
