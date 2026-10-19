# Review rework verification

Runtime and test inputs: `e1a275f` on [PR #11](https://github.com/lyrolab/nest-shared/pull/11), preserving Simplifier commit `d8497af`. Runtime, fixture, dependency, or Jest configuration changes invalidate affected results.

## Findings addressed

- Every mutable integration fixture has a random invocation name and is recorded only after successful CREATE. The supplied base is used for administration only; the harness writes its sentinel into its own fixture base. Unicode/quoted and 63-byte bases have unique names.
- Cleanup checks this invocation's recorded database names. Starting and final catalogs are evidence, not equality assertions. A peer can create or remove databases during a run.
- Evidence storage uses RUNNER_TEMP or the documented local cache. Application/test code reads no orchestration variables.
- The factory initializes without automatic schema setup, then uses TypeORM runMigrations/synchronize under the library's cleanup error aggregation. A real failing migration plus failing destroy preserves both errors.
- Failed cleanup retains its state and rejects setup, factory access, and Nest registration until explicit cleanup succeeds. Normal ready setup remains idempotent.
- Root and database READMEs describe the supported local PostgreSQL recipe, readiness, DATABASE_URL, normal commands, and owner-only container shutdown. No automatic TestContainers claim remains.

## Commands

- `npm test -- --runInBand src/database/shared-database.module.spec.ts`: 25/25 pass, natural exit 0.
- `npm ci` with every orchestration variable removed: exit 0, including Husky setup and prepare build; dependency files unchanged.
- `npm run build`: pass.
- `npm run lint`: pass, no source changes.
- `openspec validate isolated-test-databases --strict`: pass.
- `git diff --check`: pass.

Both Test workflow jobs pass at e1a275f: [push](https://github.com/lyrolab/nest-shared/actions/runs/38167697511) and [pull request](https://github.com/lyrolab/nest-shared/actions/runs/38167700472).

## Shared-server acceptance

Two ordinary `npm test -- --runInBand` commands started together on one freshly created PostgreSQL 16 container at 127.0.0.1:32793. Their environments omit every orchestration variable and use DATABASE_URL=postgres://postgres:local@127.0.0.1:32793/verification. Neither RUNNER_TEMP nor a custom identity is required; both use the documented local cache.

The server was seeded with public.base_sentinel row 99 in the supplied base and the fixed 63-byte database from the review reproduction. Each suite creates its own fixture base and leaves those existing resources alone. An independent peer retains row 99; a dedicated query runner holds a physical peer connection and checks its backend PID and sentinel repeatedly during the overlapping runs. A separate loop creates and drops only its own unique churn databases.

Each database run records 19 library databases and passes all 18 PostgreSQL scenarios, including actual multiple workers and natural intentional failure exits. Both combined lifecycle regressions pass against real PostgreSQL. One aggregate returns both intentional migration failure and intentional automatic destroy failure. Failed close retains the initialized factory, but setup and Nest registration reject; retry closes it, and subsequent setup creates a new source.

The two harness snapshots have different initial/final catalogs (6 → 12 and 6 → 8 entries), confirming the suites tolerate concurrent catalog activity. All their own recorded databases are absent at teardown. [Raw evidence](/api/attachments/43df3997-79ed-4695-a42c-80166e3d98cf/content) includes commands, child identities, owner names, closure errors, catalog snapshots, peer checks, and the external orchestration scripts.

Both complete suites passed 30/30 suites and 257/257 tests with zero skips, natural exit 0, and no signal (325.029 and 324.793 seconds). The supplied base sentinel remains exactly row 99; the pre-existing 63-byte database survives. The peer sentinel remains row 99. The held physical peer connection keeps backend PID 237 through 455 checks. The churn loop successfully creates and drops 163 invocation-owned databases.

Final server inspection contains only the supplied base, its pre-seeded fixed database, and PostgreSQL defaults; there are zero other client connections. The owner label and captured container ID were checked before removing only this invocation's container `8d148ea35ae8c53d06a54eaafc5a938113b77310c1a73969c7a58f84b5b728ad`. No shared server or foreign resources were changed.

## Scope

Sensitive surfaces: shared database ownership/lifecycle, public test API, and migration-backed schemas. Production forRoot/configuration/migrations and CLI implementation have no rework edits. Auth/JWT/session and LLM prompts/token files are untouched. Consumer adoption/bootstrap, consumer applications, cancelled work, skills, and agent instructions remain outside this PR.

This issue remains open through review and publication verification. Simplifier rechecks this rework, then Reviewer reviews before an autonomous merge. Founding Engineer verifies the actual semantic-release/npm version and downstream recipe; no manual publication or predicted version.
