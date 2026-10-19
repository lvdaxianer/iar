# sandbox-startup Specification

## Purpose

This capability makes the local agent sandbox start predictably in repositories that contain private workspace packages, while exposing only safe and actionable diagnostics when startup cannot bind its configured port.

## Requirements

### Requirement: Local workspace dependencies are resolved without registry substitution

The project SHALL declare its pnpm workspace package globs and SHALL prefer local workspace packages for matching `@iar/*` dependencies instead of requiring those packages to exist in the public npm registry.

#### Scenario: Demo dependencies include private local packages

- **WHEN** the demo is run from a checkout containing `packages/contracts` and other `@iar/*` workspace packages
- **THEN** pnpm SHALL resolve those packages from the local workspace rather than requesting `@iar/contracts` from npm

### Requirement: Running the demo does not implicitly install dependencies

The project SHALL allow an already-prepared checkout to run the sandbox script without an automatic network dependency installation during `pnpm run`.

#### Scenario: Registry is unavailable before startup

- **WHEN** the user runs the sandbox demo with an existing usable `node_modules` tree and npm registry access is unavailable
- **THEN** the run command SHALL proceed to the build and sandbox startup instead of failing its pre-script dependency verification

### Requirement: Port collisions have an actionable safe diagnostic

The sandbox launcher SHALL classify an address-in-use startup failure as `port_in_use` and SHALL provide a fixed user-facing hint to stop the existing process or configure another local port without exposing the raw exception or secrets.

#### Scenario: Configured port is already occupied

- **WHEN** the sandbox attempts to listen on a port already held by another process
- **THEN** the launcher SHALL exit non-zero, emit the safe `sandbox.start_failed` event with outcome `port_in_use`, and print the configured-port recovery hint
