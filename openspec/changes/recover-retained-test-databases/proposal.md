## Why

A process that exits before test teardown can leave its disposable database behind. A fresh process needs a supported way to remove that exact database from saved acquisition evidence, without creating another fixture or changing an active test invocation.

## What Changes

- Export a stateless `recoverTestDatabase` function from `@lyrolab/nest-shared/database`. Require original `TestDatabaseInfo`, the positive acquired PostgreSQL OID, independently supplied base connection configuration, and an explicit exclusive-target assertion.
- Share the existing name derivation with setup. Validate the original identity, actual base and role, exact OID and direct owner before ordinary DROP. Return `removed` or `already-absent` only after confirmed absence and successful connection closure.
- Coordinate recovery and normal test lifecycle operations with a session advisory lock held on the base database. Document the caller's exclusive disposable-target prerequisite and the limits against outside DDL.
- Bound recovery connection, queries, DROP and close; honor cancellation and retain uncertain outcomes and every close failure in safe structured errors.
- Prove the public API on native PostgreSQL with separate creator and recovery processes, refusal cases, lifecycle races, partial failures and natural exits. Keep normal setup/reset, migration and production-configuration regressions.
- Document acquisition, restricted evidence storage, recovery and retry. Keep saved `TestDatabaseInfo` plus observed OID usable without an extra ownership token. Incomplete records cannot authorize cleanup.

## Capabilities

### New Capabilities

- `retained-test-database-recovery`: exact cleanup from a fresh process, cooperative lifecycle exclusion, bounded failures and public-boundary verification.

### Modified Capabilities

None. Normal test setup and teardown retain their public behavior; their internal administration participates in the recovery lock protocol.

## Impact

- `src/database/`: public recovery function/types/error, shared private naming and administration helpers, lifecycle integration, barrel exports, README and colocated tests/fixtures. No new Nest module or parallel test composition.
- `package.json` and lockfile: declare the PostgreSQL driver used directly by the bounded administration path as an optional peer, retaining the development driver; add its development types as needed. Other module users need no PostgreSQL driver.
- `.github/workflows/test.yml`: retain the owned PostgreSQL 16 service and make native recovery coverage mandatory in CI. `.github/workflows/release.yml` and semantic-release remain the publication path.
- Sensitive surfaces: database ownership/deletion/lifecycle, migrated test fixtures, isolated restore and a public library API. Reviewer must verify production database configuration/migrations, auth/JWT/session and LLM prompt/token contracts remain intact.
- Out of scope: consumer journals/archive cleanup, application adoption, database sweeps, fixture creation during recovery, production schema changes, deployment, credentials, manual publication and readiness claims.
- After reviewed merge, Reviewer returns the same open issue to Founding Engineer. Completion requires successful release CI, the actual npm version and consumer-visible API/recipe, plus immutable PR/commit evidence. Merge alone does not resolve the dependency.
