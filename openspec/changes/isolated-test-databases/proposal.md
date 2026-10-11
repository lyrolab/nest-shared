## Why

Concurrent test commands on one PostgreSQL server can erase each other's worker databases. The shared library needs to own each test database so consumers can run ordinary tests safely and build their test schemas from migrations.

## What Changes

- Give every test invocation a stable random namespace, combined with process and worker identity. Factory and Nest connections use one captured database name.
- Expose invocation initialization before application imports, with automatic initialization for existing callers. Keep `VITEST_POOL_ID ?? JEST_WORKER_ID ?? "0"` precedence.
- Bound database names to 63 bytes, quote identifiers safely, and create only absent databases. Clear and drop require successful creation by this context; collisions preserve existing data.
- Accept TypeORM entity classes, schemas, and discovery paths in `forTest`. Add explicit migration options; migration execution disables synchronization. Existing class-list callers retain synchronized factory setup.
- Close admin pools on every path, track both connection owners, report cleanup failures, and provide supported cleanup and reset methods.
- Document the public API and consumer setup/teardown recipe in `src/database/README.md`. Cover the public boundary with unit tests and real PostgreSQL tests that exit naturally.

## Capabilities

### New Capabilities

- `isolated-test-databases`: invocation and worker ownership, safe database lifecycle, migration-backed setup, complete entity metadata, and compatible static helpers.

### Modified Capabilities

None.

## Impact

- `src/database/`: module, exported test options/identity helpers, a Nest test lifecycle provider, README, and colocated Jest coverage with test fixtures.
- `package.json` and lockfile: a development PostgreSQL driver for the regression suite. The existing database subpath exports the public API.
- `.github/workflows/test.yml`: an owned runner-local PostgreSQL service for the real database suite. Release remains `.github/workflows/release.yml` and `.releaserc.json`.
- Sensitive surfaces: shared database ownership/lifecycle, the public library test API, and executing migrations against test schemas. Reviewer must verify production `forRoot` configuration and migrations, auth/JWT/session wiring, and LLM prompt assembly/token budgeting retain their behavior.
- Out of scope: application adoption, consumer worker bootstrap, Chaster changes, previews, fixture typing work, Storybook, production deployment, and company skills or agent instructions. Consumer adoption follows the verified published release.
- Reviewer merges under standing policy, then returns the open issue to Founding Engineer for publication verification. Completion requires the actual package version/API, PR and commit, verification evidence, and supported consumer recipe; a merge alone does not complete delivery.
