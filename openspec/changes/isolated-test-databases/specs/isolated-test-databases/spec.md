## ADDED Requirements

### Requirement: Stable invocation and worker identity

The library SHALL export an invocation token creator and an idempotent pre-import initializer. Automatic initialization SHALL protect ordinary calls without shell flags. Namespace entropy SHALL prevent PID reuse from selecting another invocation's database. Both owners SHALL use one captured identity and URL. Worker selection SHALL preserve `VITEST_POOL_ID ?? JEST_WORKER_ID ?? "0"` semantics.

#### Scenario: Concurrent ordinary invocations

- **WHEN** two ordinary --runInBand Jest commands use the same owned PostgreSQL server
- **THEN** they select different database names, retain their namespaces throughout setup/use/cleanup, and factory and Nest current_database agree in each command

#### Scenario: Real workers and pre-import initialization

- **WHEN** a runner initializes a token before application/factory imports and executes tests in multiple actual workers
- **THEN** workers sharing that token select distinct names, and both connection owners in each worker use the same captured name

#### Scenario: Precedence and context reuse

- **WHEN** both worker variables exist, including an empty Vitest value, or initialization/setup repeat in the same context
- **THEN** nullish precedence and the captured namespace remain stable; a different invocation requires successful reset

### Requirement: Safe bounded database names

The library SHALL derive names no longer than 63 UTF-8 bytes, retain the complete identity digest, safely encode URL paths, and quote PostgreSQL identifiers. Full base names SHALL contribute to identity even when their readable prefixes are truncated.

#### Scenario: Unusual and long bases

- **WHEN** base names contain Unicode, spaces, quotes, percent-encoded characters, or identical long prefixes
- **THEN** names remain bounded, distinct where inputs differ, connect successfully, and quoted DDL affects only the intended database

### Requirement: Creation establishes ownership

The library SHALL CREATE an absent database and record successful creation before allowing clear/drop. It SHALL refuse a collision or replaced database and preserve its data. It SHALL never FORCE-drop, terminate sessions, adopt a database by its name pattern, or clear/drop the base database.

#### Scenario: Collision during setup

- **WHEN** the derived name already contains a sentinel before this context's CREATE
- **THEN** setup rejects and cleanup leaves that database and sentinel intact

#### Scenario: Cross-run clear and drop

- **WHEN** run A holds sentinel data while run B clears and drops its owned database
- **THEN** A's data and connections and the base database remain intact

#### Scenario: Lost ownership or active connection

- **WHEN** the captured database OID differs or an extra connection prevents normal DROP
- **THEN** cleanup rejects, preserves the database, closes its admin pool, and retains state needed to report or retry cleanup

### Requirement: Explicit migration schema and complete metadata

`forTest` SHALL accept TypeORM entity selections including classes, schemas, and discovery paths, plus the documented migration options. Both owners SHALL retain complete repository and relation metadata. Factory setup SHALL execute migrations once with synchronization disabled when migrationsRun is true. Nest SHALL neither synchronize nor rerun migrations. Existing class-list calls SHALL retain synchronized factory setup.

#### Scenario: Migration-backed discovery

- **WHEN** callers select entity discovery paths and real migrations with migrationsRun true
- **THEN** the migration creates the schema and history once, factory and Nest repositories work for all selected entities and relations, and both sources have synchronize false

#### Scenario: Invalid schema options

- **WHEN** migrationsRun true has an empty migration selection or explicit synchronize true
- **THEN** setup fails before CREATE and opens no worker connection

#### Scenario: Compatible class-list callers

- **WHEN** callers use forTest with entity classes and the existing setup/get/clear/close methods
- **THEN** factories get synchronized metadata, clear removes owned entity/junction fixtures without removing migration history, and close releases owned resources

### Requirement: Complete lifecycle and reset

Admin pools SHALL close on every path. The library SHALL track factory and Nest sources, including partial initialization, report destroy errors through a test lifecycle hook and explicit cleanup, and drop only after both owners close. Cleanup SHALL attempt remaining resources after a failure, preserve primary and cleanup errors, and retain failed cleanup state. Reset SHALL forget configuration and identity only after successful cleanup. Concurrent lifecycle operations SHALL not create untracked sources.

#### Scenario: Passing teardown and repeated setup

- **WHEN** apps close, explicit cleanup completes, and setup repeats with recorded options
- **THEN** no connections or owned databases remain after cleanup, getTestDataSource rejects after close, and repeat setup creates a fresh usable database

#### Scenario: Setup and teardown failures

- **WHEN** admin initialization/DDL, migrations, Nest compilation, source destroy, or database drop fails
- **THEN** all possible cleanup is attempted, errors remain observable, no foreign database is touched, and failed ownership/connection state is not forgotten

#### Scenario: Supported reset

- **WHEN** reset completes after successful cleanup
- **THEN** a later initializer gets a new namespace and may accept a new configuration; reset rejects if cleanup failed

### Requirement: Natural exits and executable documentation

The regression suite SHALL exercise the public boundary on an owned local PostgreSQL server, including real concurrent processes and multiple workers. Passing and intentionally failing fixtures SHALL exit naturally with accurate status and visible cleanup failures. README SHALL document initialization, migrations/discovery, application shutdown, full cleanup, reset, permissions, and compatibility. Production configuration/migrations, CLI lifecycle, auth/JWT/session behavior, and LLM prompt/token behavior SHALL retain their contracts.

#### Scenario: Passing and failing child runs

- **WHEN** the fixture runner executes passing tests, failing tests, and failing setup/teardown
- **THEN** passing runs exit zero and failing runs exit nonzero within the deadline, errors are visible, and owned resources are released where possible without forceExit or error/open-handle suppression

#### Scenario: Release handoff

- **WHEN** Reviewer merges the feature PR
- **THEN** the issue stays open and returns to Founding Engineer until semantic-release publication and the exact npm version/API, commit, verification results, and consumer recipe are recorded
