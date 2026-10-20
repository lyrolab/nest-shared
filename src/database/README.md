# Database

`SharedDatabaseModule` connects Nest applications and test factories to PostgreSQL through TypeORM. Import it from `@lyrolab/nest-shared/database`.

## Production

```ts
@Module({ imports: [ConfigModule.forRoot(), SharedDatabaseModule.forRoot()] })
export class AppModule {}
```

`DATABASE_URL` comes from ConfigService. Production loads `dist/**/*.entity.{ts,js}` and `dist/migrations/**/*.{ts,js}` relative to the application entry path, disables synchronization, and enables Nest's `autoLoadEntities`. `forRoot({ entities, migrations })` accepts explicit paths. Production migrations use the application's normal TypeORM CLI lifecycle; see `createCliDataSource` in this entry point.

## Test server and identity

Tests require an **owned local PostgreSQL server**, an existing base database, and a user with CREATE DATABASE permission. The library does not start a container. Configure the normal `DATABASE_URL` before starting your runner; ConfigModule/ConfigService read it. Both Nest and factory connections use a separate database created by this execution context. They never clear or drop the base database.

Existing `forTest({ entities: [User] })` callers keep synchronized factory setup. Ordinary invocations initialize identity automatically. Names include a random invocation namespace, PID, and `VITEST_POOL_ID ?? JEST_WORKER_ID ?? "0"`. Names fit PostgreSQL's 63-byte bound, including UTF-8 prefixes. A collision fails without erasing or adopting the existing database.

A runner can establish identity before importing application modules or factories:

```ts
import {
  createTestDatabaseInvocation,
  SharedDatabaseModule,
} from "@lyrolab/nest-shared/database"

// The runner host may pass this value to all its worker contexts.
const invocation = createTestDatabaseInvocation()
SharedDatabaseModule.initializeTestInvocation(invocation)
const { TestAppModule } = await import("./test-app.module")
```

Initialize each worker with the shared token before its application imports. PID and worker ID still distinguish its database. Repeat initialization returns the same token; a different token requires successful reset. Separate Jest module realms automatically isolate themselves; sharing a token also gives them a common invocation namespace. No URL is computed at module import time.

`getTestDatabaseInfo(configService?)` returns a frozen `{ namespace, processId, workerId, databaseName }` without connection credentials. It captures DATABASE_URL once. A different URL in that context fails. Standalone setup accepts a ConfigService; Nest supplies its injected service. Both must resolve the same URL.

## Schema options

Import the real module in the application's test composition:

```ts
@Module({
  imports: [
    ConfigModule.forRoot(),
    SharedDatabaseModule.forTest({ entities: [User, Message] }),
  ],
})
export class TestAppModule {}
```

`ForTestOptions.entities` accepts TypeORM entity classes, EntitySchema values, explicit discovery paths, or a TypeORM selection map. Include all relation targets. Choose source **or** compiled paths so TypeORM does not discover both versions of an entity. The factory gets exactly the same metadata selection as Nest; `autoLoadEntities` does not populate the separate factory.

For a migration-backed schema:

```ts
SharedDatabaseModule.forTest({
  entities: [join(__dirname, "**/*.entity.ts")],
  migrations: [InitialSchema1700000000000],
  migrationsRun: true,
  migrationsTableName: "migrations",
  migrationsTransactionMode: "all",
})
```

The factory runs migrations once with synchronization disabled. Nest never synchronizes or reruns migrations. `migrationsRun: true` requires a nonempty migration selection and rejects explicit `synchronize: true` before creating a database. Without migration execution, synchronization defaults to true; `synchronize: false` is supported. `schema` and `namingStrategy` are forwarded to both owners, along with the migration options. `entities` remains required.

Equivalent registrations are allowed. Changing options requires `resetTestDatabase()` after cleanup. Call `setupTestDatabase(configService?)` before using factories, or compile Nest and let the module await setup. Concurrent setup calls share the same work. `getTestDataSource()` returns the factory's DataSource only after successful setup.

## Clear and teardown

`clearTestDatabase()` truncates ordinary entity and junction tables, with quoted schema/table identifiers. Views and migration history are excluded. Migration-only tables without entity metadata are outside automatic fixture clearing. Foreign-database metadata is rejected. Calling clear before setup is harmless.

Finish app work and close every Nest application or testing context before releasing the database. Nest's test lifecycle hook reports destroy failures. Explicit `closeTestConnection()` attempts every tracked target owner, then drops the successfully created database only after all owners close and its catalog OID matches. It uses ordinary DROP; another open connection makes cleanup reject. It never terminates sessions or uses FORCE.

Always attempt explicit cleanup even after setup, test, or app shutdown fails:

```ts
const apps: TestingModule[] = []
const errors: unknown[] = []
try {
  await SharedDatabaseModule.setupTestDatabase()
  const app = await Test.createTestingModule({
    imports: [TestAppModule],
  }).compile()
  apps.push(app)
  await runTests(app, SharedDatabaseModule.getTestDataSource())
} catch (error) {
  errors.push(error)
} finally {
  for (const app of apps) {
    try {
      await app.close()
    } catch (error) {
      errors.push(error)
    }
  }
  try {
    await SharedDatabaseModule.closeTestConnection()
  } catch (error) {
    errors.push(error)
  }
}
if (errors.length === 1) throw errors[0]
if (errors.length > 1)
  throw new AggregateError(errors, "Test and cleanup failed")
```

Successful close is idempotent and invalidates `getTestDataSource()`. Setup can then recreate the database with the recorded options and identity. Cleanup failures retain state for retry and block new setup. `resetTestDatabase()` performs full cleanup, then forgets the options, URL, and invocation. It rejects without forgetting state if cleanup fails. Setup, clear, close, and reset reject incompatible overlapping operations; wait for the active operation before retrying.

An interrupted process can leave its database behind. Use exact recovery below after establishing exclusive access; the library never scans for abandoned databases. A replacement database with another OID is preserved and cleanup fails. Report that ownership failure; only the server owner can decide how to remove external data. Do not force runner exits or suppress cleanup errors.

## Recover an exact retained database

`recoverTestDatabase` works in a fresh ordinary Node, Jest or Vitest process. Install `pg ^8.23.1` when using test administration. The administration helper supports Node TCP and pg's PostgreSQL SSLRequest negotiation, with pg TLS and certificate/hostname checks intact. Unix sockets, custom streams, direct TLS negotiation and connection-string binding overrides are refused. Production `forRoot` configuration is independent of these administration bounds.

TLS certificate paths (`sslrootcert`, `sslcert`, `sslkey`) must refer to regular files. Configuration reads share the recovery work deadline and cancellation signal; each opened file closes before loading returns. FIFOs, devices and directories are refused before connecting.

After successful setup, save the original info and a positively observed OID in a restricted record:

```ts
import { ConfigService } from "@nestjs/config"
import {
  SharedDatabaseModule,
  type TestDatabaseInfo,
} from "@lyrolab/nest-shared/database"

const config = new ConfigService()
SharedDatabaseModule.forTest({ entities: [] })
await SharedDatabaseModule.setupTestDatabase(config)
const database: TestDatabaseInfo =
  SharedDatabaseModule.getTestDatabaseInfo(config)
const source = SharedDatabaseModule.getTestDataSource()
const rows: { oid: number }[] = await source.query(
  "SELECT oid FROM pg_database WHERE datname = current_database()",
)
if (rows.length !== 1 || !Number.isInteger(rows[0].oid) || rows[0].oid <= 0)
  throw new Error("Database acquisition was not confirmed")
const saved = { database, acquiredOid: rows[0].oid }
// Persist saved durably with restricted permissions before starting disposable work.
```

The application owns record persistence. Store no credentials in this record. Keep the original namespace, creator PID, worker ID, database name and OID unchanged. Existing records with these fields need no extra token; records without acquisition evidence are refused. Looking up an arbitrary existing name does not establish acquisition.

Before recovery, confirm the original creator has stopped and ensure no outside actor can rename, replace, change ownership of, connect to or recreate the target during recovery. An exclusive target is required even when an advisory lock can be acquired. If that prerequisite is unknown, do not recover.

Resolve the base configuration independently through the normal ConfigService and `DATABASE_URL`. Validate its host, port, base database, role and disposable purpose against your own allowed configuration; do not copy a connection URL from the saved record. Then, in the fresh process:

```ts
import { ConfigService } from "@nestjs/config"
import { recoverTestDatabase } from "@lyrolab/nest-shared/database"

const config = new ConfigService()
const databaseUrl = config.getOrThrow<string>("DATABASE_URL")
// Your independently validated disposable role; do not derive trust from saved evidence.
const expectedRole = "disposable_role"
const result = await recoverTestDatabase({
  base: { databaseUrl, expectedRole },
  database: saved.database,
  acquiredOid: saved.acquiredOid,
  exclusiveTarget: true,
  timeoutMs: 30_000,
  closeTimeoutMs: 5_000,
  signal: controller.signal,
})
// Both statuses confirm exact absence and successful local connection closure.
if (result.status === "removed" || result.status === "already-absent") {
  // Durably record success before deleting the retained journal.
}
```

`saved` is your validated retained record and `controller` is an AbortController owned by your caller. Caller evidence is trusted input, not an authentication token. The function recomputes the original name under the same 63-byte rules, validates actual base/session/current role, acquires the target lock, and checks exact OID and direct ownership. It refuses templates, reserved/base/current databases, changed identity and same-name replacements. A saved OID found under a different name is refused rather than treated as absence.

Recovery uses ordinary `DROP DATABASE`, with no FORCE, peer termination, elevated role, fixture setup, migrations or data changes. A connected target makes it fail. No DDL is retried automatically. Only an explicit later recovery can confirm an uncertain outcome or return `already-absent`. Neither recovery result changes the current `SharedDatabaseModule` invocation.

`timeoutMs` bounds the work phase (default 30,000 ms, maximum 300,000 ms). `closeTimeoutMs` separately bounds mandatory close (default 5,000 ms, maximum 30,000 ms); both must be positive integers. Total time is bounded by their sum plus event-loop scheduling. Close reserves its final half for forced disposal and closure confirmation of the helper-owned socket. Cancellation or work deadline stops dispatch and disposes the socket immediately. A graceful-close failure still rejects even if forced disposal succeeds. Ordinary callers need no forced process exit.

`TestDatabaseRecoveryError` exposes only fixed safe diagnostics: `code`, `phase`, `outcome` and ordered `failures`. Preserve the whole failure list, including CLOSE_FAILED alongside any primary failure. `not-attempted` means DROP was never dispatched; `unknown` means deletion may have completed. `removed` and `already-absent` on an error retain the observed absence but do not mean cleanup succeeded. Keep earlier failures when recording a later successful retry. Raw server errors, connection details, names and OIDs are not attached to the public error.

Each active normal invocation holds one extra base connection from before CREATE until target owners close, exact deletion is verified and the lease closes. The same session advisory lock covers setup, active use, clear and teardown. Cooperating recovery returns BUSY while that lease is held; different targets remain independent. Lease loss blocks new setup/clear/use. Cleanup retry reacquires the lock and revalidates saved identity before DDL. Target close failures retain cleanup state and the lease; a confirmed DROP followed by close failure also retains retry state.

Advisory locks coordinate participating library processes. They cannot make catalog lookup plus name-based DROP atomic against outside DDL, and older library processes do not hold this lease. Local socket closure also does not prove immediate server lock release during a network partition. A retry that finds server-side contention returns BUSY; it never steals a lock. Plan capacity for the extra base session and always finish or retry normal teardown.

## Library verification

Install with `npm ci` from the repository root. Docker and Node.js are required for this recipe. It creates a fresh PostgreSQL 16 container with an automatically assigned local port. Keep the returned container ID in the same shell; shutdown targets only that container.

```bash
npm ci
verification_container=$(docker run -d -e POSTGRES_PASSWORD=local -e POSTGRES_DB=verification -p 127.0.0.1::5432 postgres:16)
cleanup_verification() { docker rm -f "$verification_container"; }
trap cleanup_verification EXIT
for attempt in $(seq 1 60); do
  if docker exec "$verification_container" pg_isready -U postgres -d verification; then break; fi
  sleep 1
done
docker exec "$verification_container" pg_isready -U postgres -d verification || exit 1
verification_port=$(docker port "$verification_container" 5432/tcp | cut -d: -f2)
export DATABASE_URL="postgres://postgres:local@127.0.0.1:$verification_port/verification"
npm run build
npm test -- --runInBand
npm run lint
# End this shell or run the owner-only shutdown explicitly:
cleanup_verification
trap - EXIT
```

You can also supply DATABASE_URL for a healthy local server with CREATE DATABASE permission. The integration harness creates its own unique fixture base; it never writes fixtures into the supplied base database. `RUNNER_TEMP` selects evidence storage when supplied; otherwise evidence goes under `.cache/nest-shared-tests`. No orchestration identity or variables are required.

`npm test` visibly skips the real-server suite when DATABASE_URL is absent. For just database acceptance, use `npm test -- --runInBand src/database`. CI provides its own PostgreSQL service. The suite covers real migrations and discovery, concurrent ordinary Jest commands, actual multiple workers, sentinel preservation, both connection owners, and natural passing/failing exits. Child evidence records names, identities, commands, exit status, and cleanup; fixture code is excluded from the published build.
