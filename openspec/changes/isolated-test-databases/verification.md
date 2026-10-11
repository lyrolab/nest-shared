# Implementation verification

Tested code: `dc6e8984631e054ab0afa07306b7bac5253dd98c` on [PR #11](https://github.com/lyrolab/nest-shared/pull/11). Later task/evidence/packaging edits do not change runtime or test inputs. Runtime, fixture, dependency, or Jest configuration changes invalidate the affected evidence.

## Commands and results

- `npm ci`: passed with the committed package/lock files and prepare build. Lock SHA-256: `d67dbfe64bc23f1884b889feb2014fe9f7efc24e5f3e68cd8bc49584e86d8881`.
- `env -u PAPERCLIP_RUN_SCRATCH_DIR RUNNER_TEMP="$PAPERCLIP_RUN_SCRATCH_DIR" DATABASE_URL=postgres://nest_shared:local_owned@127.0.0.1:32786/nest_shared npm test -- --runInBand`: passed, 30 suites / 255 tests, zero skips, exit 0, 331.43 seconds. This also exercises the CI RUNNER_TEMP fallback for child fixtures.
- `npm run build`: passed. No database fixtures or specs in dist.
- `npm run lint`: passed without warnings or source changes.
- `openspec validate isolated-test-databases --strict`: passed.
- `npm pack --ignore-scripts --dry-run --json` in a clean export of the tested branch plus built dist and the final `.npmignore`: 235 files, public database JS/types present, fixtures/specs/cache files excluded. This is inspection only; no publication.

Both Test workflow runs passed at the tested SHA: [pull request](https://github.com/lyrolab/nest-shared/actions/runs/38166024113), [push](https://github.com/lyrolab/nest-shared/actions/runs/38166021105). Each uses the workflow-owned PostgreSQL service and runs `npm ci` then `npm test`.

## Server and boundaries

The local PostgreSQL 16 container `lyr104-applier-postgres` was created for LYR-104, labelled `paperclip.issue=LYR-104`, and exposed only at 127.0.0.1:32786. Container: `c9f4e0f63c5fac4087bbe8fae0a28f1461625c383554e197f56239be4fe16c89`. Image: `sha256:81bd698b4594e751a3269e4dcd3e03a4a0ec0daf7b72e7aa1abd43cce9887542`. No application PostgreSQL service was used.

All 16 database scenarios passed. Real migrations loaded through TypeORM paths with synchronization disabled. Entity discovery retained class, EntitySchema, relation and junction metadata in both owners. Schema-qualified/quoted clearing left migration history and migration-only data intact. Long and Unicode/quoted base names connected correctly. Collisions and replacement sentinels were preserved. Ordinary DROP rejected an extra connection; retry succeeded after it closed.

Concurrent ordinary commands initialize their own random identity before app/factory imports, without a runner-supplied token. Actual multiple Jest workers share one host-created token and use distinct PIDs/worker IDs/databases. Each fixture asserts and records matching factory/Nest `current_database()`. Run A holds a written sentinel while B clears and drops its own database, then reads its sentinel successfully.

Passing children exited 0; intentional test/setup/compile/teardown/catalog/admin/factory failures exited 1 naturally. Parent deadlines were not used to kill successful fixtures. All tracked owners closed. Replacement and unknown-OID fixture databases were preserved by library cleanup, then explicitly inspected/removed by the harness on its owned server. No FORCE, session termination, forceExit, or error/open-handle suppression is used.

The final catalog exactly matched the starting catalog: `nest_shared`, `postgres`, `template0`, `template1`. The base sentinel remained present. Raw evidence records exact child commands, configuration, identities, output, exit codes, closure errors and final catalog; it is saved as the Paperclip test-evidence artifact.

## Child identities and exits

| Scenario             | PID     | Worker | Namespace                                      | Database                                            | Exit |
| -------------------- | ------- | ------ | ---------------------------------------------- | --------------------------------------------------- | ---- |
| replacement          | 3925020 | `1`    | `3925020-1272faf7-2456-48d8-8119-560c378195e4` | `nest_shared_test_75f21537de4977f1ee7c95f975be140c` | 1    |
| pass                 | 3931600 | `1`    | `3931600-08e53a93-bb08-4536-971f-f75e59132741` | `nest_shared_test_a2dfaf578f60267ddef32bc941829655` | 0    |
| hold                 | 3929003 | `1`    | `3929003-c06ca4f2-58bb-4a93-8664-06fe15e206df` | `nest_shared_test_8b28d0165f8d4e2ee79588262038fe48` | 0    |
| hold                 | 3934950 | `2`    | `3909734-a6ff8a42-48e8-452b-b564-e2ded0efe8f8` | `nest_shared_test_76a73e6f752a99cd135906d1595e77ff` | 0    |
| hold                 | 3934946 | `1`    | `3909734-a6ff8a42-48e8-452b-b564-e2ded0efe8f8` | `nest_shared_test_71e7fcbb254e0418ed6fcad49c3cb46d` | 0    |
| test-fail            | 3937133 | `1`    | `3937133-fe3ab182-6269-47cf-8ed3-0169911a83d4` | `nest_shared_test_5ab148400ddba2d377231667529c7abe` | 1    |
| setup-fail           | 3939719 | `1`    | `3939719-a4aefa38-d645-4294-8552-33d5b3d9098e` | `nest_shared_test_b1c52f6678fc5a950efe3c7b67dce3d6` | 1    |
| compile-fail         | 3941925 | `1`    | `3941925-600cd3d1-420b-466d-ac19-f820e36dc490` | `nest_shared_test_40a023e9c3ac6148db65b19d659066c2` | 1    |
| teardown-fail        | 3944465 | `1`    | `3944465-7be74510-967d-4b5a-9a37-fe33cee47a38` | `nest_shared_test_1569b2db326b47d8710da8452562fa50` | 1    |
| oid-fail             | 3946022 | `1`    | `3946022-2724c304-0e62-469f-896a-f1f355e9fd10` | `nest_shared_test_e31d97bdcc0304cd4e3bbf47b707c7dc` | 1    |
| admin-destroy-fail   | 3947999 | `1`    | `3947999-a9e83464-39e5-4ade-a181-eb24cabb6a0d` | `nest_shared_test_ce105f53a42b15a1b0341fab9979098c` | 1    |
| factory-destroy-fail | 3949968 | `1`    | `3949968-640390e7-1400-47ea-b6ca-3ddad457a02d` | `nest_shared_test_dde964721ea08c26b677545b3f6e989c` | 1    |

## Scope and handoff

Production `forRoot` configuration/migrations and CLI lifecycle retain their contracts. The diff contains no auth/JWT/session or LLM prompt/token changes; their existing tests pass in the full suite. Sensitive surfaces are shared database ownership/lifecycle, the public test API, and migration-backed test schemas. Simplifier should preserve CREATE/OID ownership, connection tracking, cleanup error aggregation and lifecycle guards.

The supported consumer initialization/migration/teardown recipe is in `src/database/README.md`. Consumer adoption and worker bootstrap remain separate. Reviewer archives the completed OpenSpec change on this branch where possible, merges under standing policy, leaves LYR-104 open, and hands it to Founding Engineer for actual semantic-release/npm verification. No version is predicted and no package is manually published.

The workspace's initial local `npm pack` dry run included unrelated harness-mounted checkouts. [LYR-107](/LYR/issues/LYR-107) reports this to Founding Engineer. Clean-export package inspection passes; this environment issue does not block the feature.
