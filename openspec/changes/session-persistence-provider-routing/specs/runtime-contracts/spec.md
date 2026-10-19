# Runtime Contracts Delta

## MODIFIED Requirements

### Requirement: Function plugins declare an auditable ownership boundary

Every function plugin manifest SHALL continue to declare exactly one `functionId`, ownership, schemas, capabilities, lifecycle and policy metadata, and SHALL additionally declare a bounded list of versioned fixed `actionTypes` used only for candidate narrowing inside the selected Plugin scope.

#### Scenario: Unknown action type is rejected

- **WHEN** a Function manifest declares an action type outside the Runtime action vocabulary
- **THEN** manifest validation rejects it before the Function can enter routing candidates

#### Scenario: Plugin is not routable outside its Function

- **WHEN** a decision requests a plugin whose manifest Function differs from the selected Function
- **THEN** the runtime excludes the plugin and records the ownership mismatch as an auditable reason

### Requirement: System plugins are excluded from model routing

Runtime system plugins, including Persistence Providers and observability handlers, SHALL be loaded through explicit lifecycle or subscription registration and SHALL never appear in Function or Plugin model decision candidates.

#### Scenario: Persistence Provider is not a business candidate

- **WHEN** the runtime builds candidates for a business Function
- **THEN** a persistence system plugin is absent from the candidate set and can only be invoked by the persistence bridge

#### Scenario: Logging system plugin does not become a business candidate

- **WHEN** the runtime builds candidates for a business Function
- **THEN** a `pluginKind=system` observability plugin is absent from the candidate set and can only run through its registered event subscription
