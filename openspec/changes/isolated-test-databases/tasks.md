## 1. Invocation and public options

- [x] 1.1 Export the invocation creator, token/info types, initializer, info accessor, and ForTestOptions from the database barrel. Add unit coverage through those exports for repeated initialization, worker precedence (including empty values), PID/entropy, and conflicting identity/configuration.
- [x] 1.2 Implement the bounded UTF-8 name, structured identity digest, URL encoding, and identifier quoting. Verify long bases, shared prefixes, Unicode, quotes, empty/NUL rejection, and the 63-byte bound through public info/setup calls.
- [x] 1.3 Resolve DATABASE_URL through ConfigService and freeze one context configuration; guard repeated registration and concurrent setup. Verify standalone and Nest inputs agree and configuration drift fails before selecting another target.

## 2. Owned setup and schema

- [x] 2.1 Replace destructive setup with absent-only CREATE and successful-create/OID ownership tracking. Close admin sources on all paths and preserve primary/cleanup errors. Verify collision preservation and failures before/after CREATE at the DataSource boundary.
- [x] 2.2 Initialize the factory with TypeORM entities/discovery/schema/naming options and explicit migration settings; reject invalid migration/synchronization combinations before CREATE. Verify compatible class-list synchronization and a real migration with synchronize false.
- [x] 2.3 Wire forTest as a real Nest module using ConfigService, forRootAsync, and dataSourceFactory. Await the same setup promise and track Nest sources before initialization. Verify factory/Nest current_database and metadata match through actual repositories and relation/junction fixtures.

## 3. Clear, close, and reset

- [x] 3.1 Guard clear by active ownership/current database and quote schema/table identifiers. Truncate owned ordinary entity/junction tables, excluding views/history; reject foreign database metadata. Verify sentinel/history preservation and schema-qualified clearing.
- [x] 3.2 Add the test-only beforeApplicationShutdown provider to propagate Nest destroy errors. Implement complete closeTestConnection for all tracked owners and owned DROP after confirmed closure, with admin finally cleanup and retryable failure state. Verify app shutdown, partial compilation, both owners, and destroy/drop failures.
- [x] 3.3 Implement resetTestDatabase and lifecycle serialization/rejection. Clear static references only on successful cleanup. Verify getTestDataSource before/after lifecycle, repeated close/setup/reset, failed reset, and setup/teardown overlap without leaked pools.

## 4. Real PostgreSQL boundary coverage

- [ ] 4.1 Add pg as a development dependency, update the lockfile, and configure the test workflow with an owned runner-local PostgreSQL service and DATABASE_URL. Verify npm ci and the CI real-server suite; local absence may visibly skip integration tests, but acceptance must use the owned server.
- [ ] 4.2 Add one generic colocated runner with entity/migration and scenario fixtures, excluding fixtures from the build. Test discovery paths, EntitySchema/class callers, real migrations/history, complete relations and junction metadata, safe long/quoted names, and collision/OID checks on that server.
- [ ] 4.3 Exercise two concurrent ordinary --runInBand child commands and an actual multi-worker Jest command through the public API, with initialization before app/factory imports. Coordinate a sentinel barrier and assert distinct names, shared owner identity, no cross-run clear/drop, preserved base data, and released connections/databases.
- [ ] 4.4 Exercise passing/failing setup, test, and teardown child runs, including cleanup failures and retry. Assert natural zero/nonzero exits within a bounded parent deadline, reported errors, and no forceExit, suppressed handles/errors, or production server access. Record exact child commands, inputs/commit, names, exit statuses, and cleanup results in the issue/PR evidence.

## 5. Documentation and stage verification

- [x] 5.1 Write the current database README with the public API, owned-server permissions, ConfigService/DATABASE_URL, pre-import/shared-token recipe, explicit migration/discovery examples, metadata limits, both owners, cleanup/error aggregation, and reset/compatibility behavior. Verify examples against exported types and the fixture runner.
- [ ] 5.2 Run focused database/CLI tests, npm test against the owned server, npm run build, and npm run lint; keep hooks enabled. Record exact commands and tested commit/input hashes. Inspect the final diff to verify production forRoot/migrations, CLI hooks, auth/JWT/session wiring, and LLM prompt/token behavior retain their contracts.
- [ ] 5.3 Keep the same issue/branch/PR. Push implementation and evidence, mark apply complete in the PR body, and hand to Simplifier with sensitive surfaces explicit. Reviewer must archive completed OpenSpec artifacts on this branch where possible, merge under standing policy, and return the open issue to Founding Engineer for actual publication verification.

Publication completion belongs to Founding Engineer after review: verify release CI and the actual npm package, record exact version/API, PR/commit, commands/results, and supported consumer recipe. Keep the issue open while publication is pending; use a bounded machine-state monitor for running CI or route a failed release. No manual publish, predicted version, direct main push, or consumer installed-package edits.
