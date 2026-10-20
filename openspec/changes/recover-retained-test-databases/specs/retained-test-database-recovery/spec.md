## ADDED Requirements

### Requirement: Public recovery from original acquisition evidence

The database subpath SHALL export `recoverTestDatabase`, `RecoverTestDatabaseOptions`, `TestDatabaseRecoveryBase`, `TestDatabaseRecoveryResult` and `TestDatabaseRecoveryError`. The operation SHALL accept original TestDatabaseInfo, a positive acquired OID, independent explicit base configuration, exclusive-target assertion and bounded timeout/cancellation controls. It SHALL work in an ordinary fresh Node/Jest/Vitest process without initializing or mutating a static invocation.

#### Scenario: Creator stops before cleanup

- **WHEN** a creator acquires a database through the public module, saves its info and observed OID, and is terminated before teardown
- **THEN** a distinct recovery process with independently validated base/role and exclusive control removes only that target and exits naturally
- **AND** it requires no orchestration identity, PID override, private state mutation or fixture setup

#### Scenario: Evidence is incomplete or unsupported

- **WHEN** the record lacks a positive acquired OID, required identity or exclusive-target assertion, or has malformed/unsupported fields
- **THEN** recovery rejects before DDL and never infers acquisition from a planned name
- **AND** it does not invent missing evidence or require a new unversioned secret

### Requirement: Exact original naming and independent connection binding

Recovery SHALL use the same name derivation, UTF-8 63-byte bound and quoting rules as normal setup with the original namespace, worker ID and creator PID. It SHALL validate the actual base database and connecting session/current role against independent configuration. It SHALL refuse base/current/system/reserved/template targets, inconsistent identity and indirect ownership.

#### Scenario: Fresh process has another PID and worker

- **WHEN** recovery runs under a different PID/worker from the creator
- **THEN** the original name is recomputed from saved identity without substituting the recovery identity
- **AND** existing empty worker IDs, quoted bases and long Unicode prefixes remain compatible

#### Scenario: Binding or ownership does not match

- **WHEN** recomputed name, actual base, configured role, session role, target owner or saved OID differs
- **THEN** recovery rejects and preserves the database and its sentinel
- **AND** membership or elevated privileges do not substitute for direct ownership

#### Scenario: Same name belongs to a replacement

- **WHEN** an external actor has replaced the acquired database under the same name with a different OID
- **THEN** recovery refuses and the replacement's sentinel survives

#### Scenario: Saved OID was renamed

- **WHEN** the exact saved name is absent but its OID exists under another name
- **THEN** recovery reports an identity mismatch without deleting either name or returning already-absent

### Requirement: Confirmed removal and idempotent absence

Recovery SHALL use ordinary DROP for the single validated target without FORCE, IF EXISTS, terminating sessions, changing roles or sweeping names. It SHALL return removed only after acknowledged DROP, confirmed catalog absence and successful close. It SHALL return already-absent only after full available validation and confirmed absence of both the original name and acquired OID, followed by successful close. It SHALL perform no setup, migration, data, schema or archive work.

#### Scenario: Explicit retry after removal

- **WHEN** a successful exact removal is followed by a fresh explicit recovery with the same valid record
- **THEN** the retry returns already-absent without creating a database or issuing DROP

#### Scenario: Another connection remains

- **WHEN** a peer is connected to the exact target
- **THEN** recovery fails without terminating that peer or reporting success
- **AND** a later explicit retry after peer closure can remove the target

### Requirement: Cooperative lifecycle exclusion with explicit limits

Normal setup, active ownership, clear and teardown SHALL retain a session advisory lock for the target on the base database from before CREATE until cleanup and final lease close. Recovery SHALL acquire the same target lock and retain it through verification and close. Lock contention, loss or unverifiable identity SHALL fail safely. The documentation SHALL require a stopped creator and exclusive disposable-target control and SHALL state that the lock does not prevent arbitrary outside DDL or make name-based DROP atomic by OID.

#### Scenario: Normal lifecycle is active

- **WHEN** recovery overlaps cooperating setup, active use, clear, partial cleanup, close or recreate for the same target
- **THEN** the lock prevents recovery from deleting that invocation's database
- **AND** existing setup promises, retry/reset behavior and both TypeORM owners retain their contracts

#### Scenario: Two recoveries overlap

- **WHEN** two fresh recoveries target the same acquisition concurrently
- **THEN** at most one performs DROP and contention is reported explicitly
- **AND** an explicit retry after the first closes can confirm already-absent

#### Scenario: A sibling is still running

- **WHEN** a different invocation holds a live database and sentinel during recovery
- **THEN** that invocation can keep using its database and its sentinel survives

#### Scenario: Lease or partial cleanup fails

- **WHEN** a lifecycle lease disconnects or teardown fails before or after DROP
- **THEN** normal state is retained for retry, incompatible setup/clear is refused, and any new administration session reacquires the lock and revalidates OID before DDL
- **AND** neither recovery nor reset silently forgets a failure

### Requirement: Bounded cancellation, uncertainty and safe errors

Recovery SHALL bound all work with timeoutMs and mandatory close with closeTimeoutMs, using the defaults and limits in design.md. It SHALL honor cancellation before destructive dispatch, stop further queries after failed validation and close every new session on all paths. Post-dispatch response loss or unconfirmed postconditions SHALL retain an unknown outcome. Every close failure SHALL reject, including after confirmed absence. Error messages and structured failure entries SHALL exclude names, OIDs, URLs, credentials and raw driver errors.

#### Scenario: Cancellation before DROP

- **WHEN** cancellation or deadline occurs before DROP dispatch, including during connect or inspection
- **THEN** recovery closes within its cleanup budget, reports not-attempted, and cannot issue a late DROP

#### Scenario: DROP response or verification is uncertain

- **WHEN** cancellation, timeout, connection loss or failed verification follows DROP dispatch
- **THEN** recovery rejects with an unknown outcome and does not retry DDL automatically
- **AND** an explicit later retry may establish absence without erasing the prior failure

#### Scenario: Primary failure and close failure coexist

- **WHEN** work fails and the newly opened client also fails or times out during close
- **THEN** the error retains both ordered safe failure entries and exits without unhandled promises
- **AND** confirmed absence followed by close failure still rejects with the observed outcome retained

### Requirement: Native public-package proof and consumable release

The change SHALL include mandatory native PostgreSQL CI coverage using real creator and fresh recovery processes, public compiled-subpath imports and declarations. It SHALL preserve normal setup/reset, migration and production/CLI regressions, document acquisition/recovery/compatibility, and release through the existing reviewed semantic-release workflow. Completion SHALL require verified actual publication, consumer-visible API/recipe and immutable PR/commit evidence.

#### Scenario: Public package is verified

- **WHEN** native CI runs on its owned PostgreSQL service
- **THEN** exact removal, retry, all refusal cases, lifecycle contention, deadlines/cancellation and natural recovery exits are exercised without skips
- **AND** injected transport/close failures are identified separately from native evidence, and fixtures are excluded from dist

#### Scenario: Release is pending or failed

- **WHEN** review has merged the feature but publication is pending or failed
- **THEN** the issue stays open with Founding Engineer responsible for release verification or repair routing
- **AND** no predicted version, manual publication, consumer installed-package patch or readiness claim substitutes for a verified consumable release
