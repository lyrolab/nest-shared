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

Finish app work and close every Nest application or testing context before releasing the database. Nest's test lifecycle hook reports destroy failures. Explicit `closeTestConnection()` attempts every tracked owner and admin pool, then drops the successfully created database only after all owners close and its catalog OID matches. It uses ordinary DROP; another open connection makes cleanup reject. It never terminates sessions or uses FORCE.

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

An interrupted process can leave its database behind. The library does not scan for or reclaim abandoned databases. A replacement database with another OID is preserved and cleanup fails. Report that ownership failure; only the server owner can decide how to remove external data. Do not force runner exits or suppress cleanup errors.

## Library verification

`npm test` visibly skips the real-server suite when DATABASE_URL is absent. To run all database acceptance tests, start an owned PostgreSQL server and provide DATABASE_URL to `npm test -- --runInBand src/database`. CI provides its own PostgreSQL service. The suite covers real migrations and discovery, concurrent ordinary Jest commands, actual multiple workers, sentinel preservation, both connection owners, and natural passing/failing exits. Child evidence records names, identities, commands, exit status, and cleanup; fixture code is excluded from the published build.
