## Context

The database API has two connection owners: the static factory DataSource and the Nest TypeORM DataSource. `forTest` records entity classes and builds Nest options; setup creates the worker database and synchronizes the factory schema. `forRoot` and `createCliDataSource` are separate production contracts.

The design uses the verified consumer contract and upstream commit `0a30b73f4385c1ab700eb8e98d60b7ce7793f0a7`. Consumer environment setup shows why identity must exist before application imports and why applications close before database release. No consumer code is part of this change.

## Goals / Non-Goals

Goals: automatic isolation on one owned PostgreSQL server, safe ownership, migration-backed schemas with complete metadata, compatible class-list calls, and cleanup that reports errors and lets the process exit naturally.

Non-goals: consumer bootstrap or dependency adoption, production configuration changes, auth/session/JWT changes, prompt/token changes, deployment, or an abandoned-database sweeper.

## Decisions

### 1. Capture invocation identity before deriving any URL

Export these symbols from the existing `@lyrolab/nest-shared/database` entry:

```ts
export interface TestDatabaseInvocation {
  readonly namespace: string
}

export function createTestDatabaseInvocation(): TestDatabaseInvocation

export interface TestDatabaseInfo {
  readonly namespace: string
  readonly workerId: string
  readonly processId: number
  readonly databaseName: string
}
```

`createTestDatabaseInvocation()` returns a frozen token containing process identity and a cryptographically random UUID. It reads no database URL and opens no connection. A test runner can create the token in its host environment and pass the same token to its workers before application imports. This is a supported value handoff, without environment mutation or a global constant.

Add `SharedDatabaseModule.initializeTestInvocation(invocation?: TestDatabaseInvocation): TestDatabaseInvocation`. With no argument it initializes once and returns the same token on repeat calls. Supplying the same token is idempotent; changing a captured token requires full reset. It captures the current process ID and worker ID through ConfigService, using `VITEST_POOL_ID ?? JEST_WORKER_ID ?? "0"` (including empty strings). PID plus UUID prevents reuse of a stale process namespace. The identity stays fixed until reset.

`forTest` calls this initializer automatically before saving its configuration. There are no database URLs computed at module import time. Existing consumers require no special shell flags. Separate Jest module realms can supply the same runner-created token; default realms allocate distinct tokens and still isolate safely. The namespace is stable within each initialized execution context, including repeated module registrations and lifecycle cycles. A shared runner token makes it stable across realms/workers too; each worker/process still has its own database.

The library supplies the API and verifies pre-import timing; consumer runner/bootstrap changes belong to adoption. A worker-only suffix and PID-only suffix cannot provide the required isolation and PID-reuse protection.

### 2. Resolve DATABASE_URL once through ConfigService

Add `getTestDatabaseInfo(configService?: ConfigService): TestDatabaseInfo` and allow `setupTestDatabase(configService?: ConfigService): Promise<void>`. These capture configuration on first resolution. Standalone helpers default to a normal ConfigService reading the runner's configured environment; Nest supplies its injected ConfigService. `DATABASE_URL` keeps its production name. A differing URL in the same active context is an error, rather than a second database target. Diagnostics expose the database name, never credentials or the connection URL.

`forTest` is a real Nest dynamic module using `TypeOrmModule.forRootAsync`, ConfigModule/ConfigService, and a test lifecycle provider. Its factory waits for setup and uses the captured owned URL. Setup before Nest compilation remains supported; direct Nest compilation also awaits the same setup promise. Concurrent setup calls share one promise and cannot create two databases or run the schema twice. A conflicting `forTest` configuration fails clearly; equivalent repeated registration is allowed.

No raw spec-body `process.env` mutation, test-only configuration keys, custom file scanner, or copied provider arrays are needed.

### 3. Bound names without losing identity

Decode the base database component of DATABASE*URL. Build `<base-prefix>\_test*<digest>`, where the digest is 32 hexadecimal characters from SHA-256 over the full decoded base name, namespace, process ID, and selected worker ID. Use an unambiguous structured encoding for hash inputs. Reserve the complete suffix and truncate only the prefix at UTF-8 code-point boundaries to keep the result at most 63 bytes. Reject an empty base component and NUL characters. Different full base names that share a prefix remain distinct.

Use URL path encoding for connection URLs and PostgreSQL identifier quoting for DDL. Escape embedded double quotes by doubling them; table truncation quotes schema and table separately. Never interpolate a raw base name, worker ID, or URL into SQL. Keep the database name fixed before either owner connects. PostgreSQL documents the [63-byte bound and quoting rules](https://www.postgresql.org/docs/current/sql-syntax-lexical.html).

### 4. Successful CREATE grants ownership

Connect an admin DataSource to the base URL and issue CREATE DATABASE for the derived name, without an earlier DROP. A duplicate-name error fails setup and preserves the existing database; it does not adopt that database or retry a destructive path. Record ownership only after CREATE succeeds, together with the created database's catalog OID. Only that owned record permits clear/drop. Resolve the same OID before cleanup to refuse a name that has been replaced. The base database and names outside the captured owned record are never cleanup targets.

Keep the successful-create record during partial setup failures so rollback can release the newly created database. A failure before CREATE grants no ownership. All admin initialization, DDL, catalog checks, and destroy operations use try/finally. Retain both the original error and cleanup errors, using AggregateError when there is more than one.

No FORCE, session termination, pattern-based drop, or adoption by `_test_` suffix. A database with another live connection is preserved and cleanup fails visibly: [ordinary DROP DATABASE refuses active connections](https://www.postgresql.org/docs/current/sql-dropdatabase.html). Interrupted processes can leave an owned database behind; this change does not scan or reclaim it.

### 5. Use TypeORM options for entities and migrations

Export `ForTestOptions`. Its entity and migration fields use TypeORM's own option types:

```ts
interface ForTestOptions {
  entities: NonNullable<DataSourceOptions["entities"]>
  migrations?: DataSourceOptions["migrations"]
  migrationsRun?: boolean
  synchronize?: boolean
  migrationsTableName?: string
  migrationsTransactionMode?: DataSourceOptions["migrationsTransactionMode"]
  namingStrategy?: DataSourceOptions["namingStrategy"]
  schema?: string
}
```

Entity classes, EntitySchema values, and TypeORM discovery paths are supported. `entities` remains required; paths are explicit caller options, with TypeORM doing the discovery. Both owners receive the same full entity options, schema, and naming strategy. Do not infer metadata from migration-created tables or rely on Nest `autoLoadEntities` to populate the separate factory. The latter omits entities registered only through relations, as the [Nest documentation explains](https://docs.nestjs.com/data/typeorm).

The factory alone initializes the schema. `migrationsRun: true` requires a nonempty migration selection, sets factory synchronization false, and runs pending migrations once. Reject explicit `synchronize: true` combined with migration execution before any CREATE. Forward the migration table and transaction mode. With migrationsRun omitted/false, factory synchronization defaults to true; explicit false is supported. Nest always uses synchronize false and migrationsRun false. Migration selections remain available in its configuration, without executing them twice. These are standard [TypeORM DataSource options](https://typeorm.io/docs/data-source/data-source-options/).

`forTest({ entities: [User] })`, the four existing static helpers, and the factory DataSource return type remain supported. Generated database names are internal and intentionally change. `closeTestConnection` gains complete owned cleanup; callers must finish using their apps before calling it. Production `forRoot` defaults, discovery, migrations, autoLoadEntities, and CLI lifecycle behavior retain their contracts.

### 6. Track both owners and report teardown failures

Use Nest's supported `dataSourceFactory` to construct and track its DataSource before initialization. Track partially initialized sources too. Avoid retries that allocate untracked pools; test connection creation uses one attempt and propagates setup errors. The factory DataSource is tracked independently.

A test-only injectable provider uses `beforeApplicationShutdown` to close its Nest DataSource and propagate failures before TypeOrmModule's shutdown hook. The installed Nest TypeORM shutdown hook catches destroy errors and only logs them, so relying on that hook alone loses required error evidence. Use plain DataSource methods and standard Nest lifecycle hooks, without patched destroy methods or a custom connection abstraction.

`closeTestConnection(): Promise<void>` attempts every tracked source, then drops the known owned database only after all owners are confirmed closed. It closes its admin connection even when drop fails. A failed owner close prevents release, retains enough state for retry, and rejects. A successful close clears connection/ownership references; another setup with the recorded options can create a fresh owned database. Repeated close after success is harmless.

Add `resetTestDatabase(): Promise<void>`: await the same full cleanup, then forget options, URL, setup promise, sources, and invocation identity. It refuses to forget failed cleanup state. The next initialization creates a new namespace. `getTestDataSource` rejects before successful setup and after close/reset. Concurrent setup/close/reset are serialized or rejected clearly; they cannot resurrect a connection during teardown.

`clearTestDatabase` checks active ownership and the current database before truncation. It truncates deduplicated ordinary entity and junction tables in the owned database, quoting schemas/tables and excluding views and migration history. Metadata configured to target a different database is rejected. Clear before setup remains a no-op. Migration-only tables without entity metadata are outside the automatic fixture-clear contract and must be documented.

### 7. Publish a usable consumer recipe

The README describes an owned PostgreSQL server, CREATE DATABASE permission, DATABASE_URL, both connection owners, class-list and migration/discovery options, and lifecycle/reset semantics. No automatic container claim. Its recipe has this order:

1. Establish invocation identity through the initializer before application/factory imports; runners can share a token across their worker contexts.
2. Register `forTest` with explicit entities and, for migration setup, migrations plus migrationsRun true. Run setup before factories or compile Nest and await its setup.
3. Clear fixtures between tests. Finish app work and close every Nest application/module context.
4. Call closeTestConnection in a finally path even if setup, a test, or app.close fails. Preserve the test/app error and all cleanup errors. Reset only after successful cleanup when reconfiguring the static helper.

The README example must attempt all app closures and database cleanup, report combined failures, and use neither forceExit nor catch-and-ignore. It is a library recipe; it does not edit a consumer bootstrap.

## Verification

Keep one generic colocated Jest runner per test boundary; scenarios and fixtures are data/fixtures, not a spec per case. Unit coverage uses exported APIs with ConfigService inputs and failures at the DataSource boundary. Database coverage uses one owned local PostgreSQL server and the real public module, repositories, and factory.

Use subprocesses for concurrent --runInBand invocations and actual multiple Jest workers. The fixture runner loads invocation initialization before app/factory imports. Record namespace, worker ID, PID, current_database from both owners, exit code, and catalog cleanup. Use a barrier to hold run A's sentinel while B clears and drops. Assert A's sentinel and the base database survive. A parent test deadline fails and kills a stuck child for harness cleanup; child fixtures never force exit. Include process/module reload identity, explicit shared tokens, precedence including empty values, Unicode/quote/long bases, forced CREATE collisions, migration-created tables and relations, junction metadata, app compilation failures, migration failures, admin failures, destroy/drop failures, retry/reset, and normal passing/failing exits.

Add `pg` as a dev dependency because the library suite initializes PostgreSQL. The test workflow supplies a runner-local owned PostgreSQL service and DATABASE_URL; default local unit runs can skip the real-server suite when DATABASE_URL is absent, with a visible skip. CI must run it, and recorded acceptance cannot rely on skipped tests. Build fixtures must not ship in dist.

Record exact commands, tested commits or input hashes, server ownership, names, and results in the issue/PR evidence. After relevant focused checks, run the repository tests, build, and lint with hooks enabled. Preserve the production/CLI regression coverage and inspect the final diff for auth/session/JWT and prompt/token changes.

## Risks / Trade-offs

- Aborted processes can leave databases behind → random names avoid adoption, and no automatic destructive sweeper is added.
- Static helpers support one configuration per execution context → reject conflicting registration; full reset supports another configuration.
- Early ConfigService and Nest configuration could differ → capture one URL and reject drift before either owner switches targets.
- App closure can fail → attempt remaining closures and explicit tracked cleanup; preserve all errors and never FORCE-drop.
- Entity discovery can miss relations or load source and dist twice → pass explicit TypeORM paths, prove complete relation metadata in both owners, and document source/dist selection.

## Migration Plan

Use this issue's branch and one feature PR through apply, simplify, and review. Archive the completed OpenSpec change on this branch before merge where possible. Reviewer merges autonomously, keeps the issue open, and reassigns it to Founding Engineer.

Publication uses main's release workflow (npm ci, build, semantic-release). `.releaserc.json` governs the version; do not predict it, manually publish, push directly to main, or edit installed consumer packages. Founding Engineer verifies the successful CI run and actual npm package, records exact version/API, PR/commit and commands/results, and confirms the supported initialization/teardown recipe. A running release gets a bounded machine-state monitor; failed publication is resolved or routed. Only then can the issue complete and unblock separate adoption. Rollback is a reviewed upstream revert and normal release; consumer dependency changes remain separate.

## Open Questions

No product decision is pending. Applier must verify lifecycle-hook failure propagation and TypeORM metadata behavior against installed versions; a contract mismatch goes to Founding Engineer before changing this public design.
