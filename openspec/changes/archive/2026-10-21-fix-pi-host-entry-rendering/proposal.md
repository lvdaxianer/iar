# Proposal

## Why

The Pi host demo receives IAR bridge entries as an envelope containing the
custom entry type and its payload, but the browser renders the envelope as if
it were the payload. As a result, successful IAR routing is shown as an empty
`[IAR ]` card even though the intent and route were handled correctly.

## What Changes

- Unwrap validated `iar-bridge` entry envelopes before rendering them.
- Ignore malformed or unrelated SSE entry events without breaking the page.
- Add a regression check for the browser entry contract.

## Capabilities

### New Capabilities

- `pi-host-entry-rendering`: Render IAR bridge results received by the Pi host
  demo with their actual disposition and content.

### Modified Capabilities

## Impact

The change is limited to the Pi host demo page and its regression tests. The
Pi host session event envelope, IAR intent recognition, dynamic routing, and
Pi delegation behavior remain unchanged.
