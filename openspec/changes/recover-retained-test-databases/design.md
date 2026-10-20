## Context

`SharedDatabaseModule` derives test names from the decoded base name, namespace, creator PID and worker ID. Successful CREATE records an OID privately. Setup always creates; reset can release only that process's ownership. A recovery process must use original acquisition evidence without initializing another invocation or restoring private static fields.

The existing module, database barrel, README, integration runner and PostgreSQL 16 CI service supply the work sites. Production `forRoot` and CLI configuration are outside the implementation scope. No application schema migration is needed.

## Goals / Non-Goals

**Goals:** remove only an exact retained disposable database; support explicit idempotent retry; coordinate cooperating lifecycle operations; bound recovery and preserve failures; ship a usable public package contract.

**Non-Goals:** database discovery/adoption, prefix cleanup, fixture setup, schema/data operations, consumer journal/archive management, process termination, production changes or manual publication.

## Decisions

### 1. A stateless public function with explicit inputs

Export these names through `src/database/index.ts` and the existing database subpath:

```ts
interface TestDatabaseRecoveryBase {
  readonly databaseUrl: string
  readonly expectedRole: string
}

interface RecoverTestDatabaseOptions {
  readonly base: TestDatabaseRecoveryBase
  readonly database: TestDatabaseInfo
  readonly acquiredOid: number
  readonly exclusiveTarget: true
  readonly timeoutMs?: number
  readonly closeTimeoutMs?: number
  readonly signal?: AbortSignal
}

type TestDatabaseRecoveryResult =
  | { readonly status: "removed" }
  | { readonly status: "already-absent" }

function recoverTestDatabase(
  options: RecoverTestDatabaseOptions,
): Promise<TestDatabaseRecoveryResult>
```

`exclusiveTarget` is the caller's assertion that the original worker has stopped and no outside actor will rename, replace, alter ownership of, reconnect to, or recreate this target during recovery. It is a required prerequisite, not a server-authenticated fact. The function cannot establish exclusivity from a saved PID or a suffix. Missing/false assertion refuses before connecting.

The caller resolves the normal `DATABASE_URL` through ConfigService and supplies it independently of the retained record. `expectedRole` is its independently allowed disposable role. Require an explicit PostgreSQL URL host, user and base database; decoded URL user must equal expectedRole. Prevent connection-string overrides or implicit PG environment defaults from changing that binding. Keep supported TLS configuration intact. Validate the actual connection as described below; URL parsing alone cannot prove provenance.

The function neither reads nor changes the current static invocation, options, sources or configuration. A failed or successful recovery cannot reset a sibling context. A separate function is simpler than an adoption method that populates process-local ownership.

Do not add a new secret, acquisition token or descriptor format. Original `TestDatabaseInfo` plus a positively observed acquired OID remains the evidence contract. Records containing only a planned name or missing OID fail. Caller evidence is trusted input, not authentication; the caller must protect its records and validate host/port/base, role and source-versus-target purpose independently. Do not fabricate acquisition evidence by looking up an arbitrary existing name.

### 2. Reuse the exact existing name calculation

Extract a private pure helper used by both `getTestDatabaseInfo` and recovery. Preserve SHA-256 over `JSON.stringify([decodedBaseName, namespace, processId, workerId])`, the first 32 hexadecimal digits, `_test_` suffix and prefix truncation at UTF-8 code-point boundaries to at most 63 bytes. Preserve identifier quoting and URL path encoding. No new naming version or current-process substitution.

Validate runtime input types before network work. Require nonempty, NUL-free namespace/name; string worker ID, including the existing valid empty string; positive safe-integer creator PID; and positive integer OID within PostgreSQL's unsigned 32-bit range. Reject invalid Unicode, malformed URL/encoding, empty base, overlong target, nonfinite deadlines, unsupported record shapes and recomputed-name mismatch. Read/copy validated primitive inputs once so caller mutation during awaits cannot change the target.

Refuse targets equal to the decoded base, actual current database, `postgres`, `template0`, `template1`, or PostgreSQL-reserved `pg_` names. Refuse catalog-marked templates even with another name. Validate all available evidence before treating absence as idempotence.

### 3. Pin one base session for the ownership check and DROP

Use the existing PostgreSQL driver through its public `pg.Client` API for bounded administration, with no pool, reconnect, retries, SET ROLE or driver-private socket access. Declare pg as an optional peer, keeping the development dependency and adding development types. Load it only when database administration is invoked so importing the barrel or using another module does not require the driver. Keep TypeORM/Nest for application/factory composition.

The session sequence is:

1. Validate/capture input and check cancellation/deadline before connect.
2. Connect to the explicit base. Query `current_database()`, `session_user`, `current_user` and their catalog identity. Require the decoded base and expectedRole to match, with current and session role equal. Require exactly one matching non-template base catalog row.
3. Acquire the target's session advisory lock using `pg_try_advisory_lock`. Contention returns a busy failure; never steal or wait indefinitely.
4. Query the exact target name with parameters. Validate unique row, exact saved OID, direct owner OID equal to the connecting role's OID, non-template status and allowed target name. Role membership or superuser powers do not substitute for direct ownership. Never enumerate names by prefix.
5. If no exact-name row exists, also look up the saved OID. A saved OID found under another name is an identity mismatch, not absence. If neither exists, record already-absent. Present targets with mismatched evidence fail without DROP.
6. Immediately before DROP, check cancellation/deadline, session health and identity again while holding the same lock. Issue only `DROP DATABASE <quoted exact name>`, with neither FORCE nor IF EXISTS. A connected peer makes ordinary DROP fail. Never terminate it or repair the database.
7. After acknowledged DROP, verify exact-name absence and that the saved OID has not moved to another name. Any remaining/replacement row fails. Return removed only after successful close.
8. On every path, close the newly opened client, observe all in-flight promise failures, and clear timers/listeners. Session closure releases its advisory lock. Preserve a close failure alongside the primary failure.

OID lookup catches a rename but does not make deletion OID-addressed. PostgreSQL accepts a name for DROP, refuses connected targets without FORCE and forbids DROP inside a transaction. A transaction or `SELECT ... FOR UPDATE` cannot provide the required atomic operation. See [PostgreSQL 16 DROP DATABASE](https://www.postgresql.org/docs/16/sql-dropdatabase.html).

### 4. Protect the whole cooperating lifecycle

Use a private shared session-lock helper, not a second database manager. Compute one stable signed 64-bit lock key from the first eight SHA-256 bytes of `JSON.stringify(["@lyrolab/nest-shared/test-database", databaseName])`. All participants connect to the same explicit base; do not include role, PID or acquired OID in the lock key. A hash collision only refuses unrelated work.

Normal setup acquires the same lock on a dedicated base session before CREATE. Retain that session through OID capture, schema initialization, active use, clear, closure of both TypeORM owners, owned DROP and verified teardown. Reuse it for administration instead of creating a separate competing administration path. It stays separate from target connections so closing the target cannot expose a gap before DROP. Release/close it last. Existing in-process busy/setup-promise guards remain.

This lifetime lock also covers initialization windows with no target connection, close/recreate with the same identity and module realms using a shared identity. Another recovery cannot delete a healthy active invocation. Two recoveries contend on the same key; a later explicit retry can observe absence. Different targets, including a sibling with a live sentinel, remain independent.

On setup failure, retain the lease until partial sources and owned database cleanup are resolved. A pre-CREATE failure grants no ownership. On close failure retain retry state and reject new setup/reset. On unexpected lease-session loss, mark the normal context unsafe: stop further clear/setup and never issue DDL on a replacement session without reacquiring the same lock and revalidating the saved OID. A retry must preserve ownership/cleanup state, including the case where DROP succeeded but lease close failed. Do not leave an unhandled client error or silently report teardown success.

Session advisory locks coordinate participating code and are released by the server when a session ends; outside code is not forced to honor them. See [PostgreSQL advisory locks](https://www.postgresql.org/docs/16/explicit-locking.html#ADVISORY-LOCKS). This design uses no deployment catalog locks, catalog writes, extension, persistent lock table or locking service.

The lock protocol does not retroactively cover an old library process. Callers recovering an existing saved record must first stop that creator and exclude all other DDL for the target. If that prerequisite is unknown, or the lock/session/identity checks cannot be maintained, refuse. Do not describe SELECT plus DROP as atomic against arbitrary outside DDL. No automatic API can authenticate a forged record or defeat an administrator that ignores the protocol.

### 5. Bound work and preserve what is known

`timeoutMs` defaults to 30,000 and bounds the entire work phase, including connect, inspection, lock and verification. `closeTimeoutMs` defaults to 5,000 and separately bounds mandatory cleanup, so total elapsed time is bounded by their sum plus event-loop scheduling. Accept positive integer values up to 300,000 and 30,000 respectively. Reject invalid values. Cancellation never skips close or grants a fresh work budget.

Use a monotonic remaining budget, native `connectionTimeoutMillis`, `statement_timeout`, `lock_timeout` and `query_timeout`, capped to remaining work. Never queue DROP behind a timed-out validation query. Check cancellation before each operation and immediately before destructive dispatch. On timeout/abort/error, stop dispatching work and call public `client.end()` even for connecting or busy clients. Verify installed pg behavior for connect interruption and active-query closure; do not settle a Promise.race while leaving the operation able to dispatch DROP later. Handle asynchronous error events without logging sensitive server fields. See [pg.Client controls](https://node-postgres.com/apis/client) and the [8.23.1 client implementation](https://github.com/brianc/node-postgres/blob/pg%408.23.1/packages/pg/lib/client.js).

Closing a client cannot prove that an already submitted DROP did not finish. Once dispatch begins, a lost response, cancellation, deadline or failed postcondition leaves an uncertain outcome. Never retry DDL automatically. Close timeout/failure rejects even after confirmed absence. A caller can use a bounded private child as an additional process fence, but ordinary API use itself must close its connections and exit naturally; no forceExit or detached background cleanup.

Export `TestDatabaseRecoveryError extends Error` with safe fixed message and these readonly fields:

- `code`: `INVALID_INPUT | UNSAFE_TARGET | IDENTITY_MISMATCH | OWNERSHIP_MISMATCH | BUSY | CANCELLED | DEADLINE_EXCEEDED | DATABASE_FAILURE | CLOSE_FAILED`.
- `phase`: `validate | connect | lock | inspect | drop | verify | close`.
- `outcome`: `not-attempted | unknown | removed | already-absent`.
- `failures`: ordered `{ code, phase }` entries retaining the primary failure and all cleanup failures. The primary failure supplies the top-level code/phase; a close-only failure uses CLOSE_FAILED.

`not-attempted` means DROP was never dispatched. Set unknown conservatively on dispatch; promote to removed only after acknowledgement and verified absence, or to already-absent after validated catalog absence. A close failure retains that observation but still rejects. Never attach raw driver errors, connection options, names, OIDs or credentials as enumerable fields or cause. Safe error codes preserve each failure without publishing its server text. A subsequent already-absent result does not erase the caller's prior failure.

### 6. Prove acquisition and recovery through public boundaries

Extend the colocated database runners with scenario data and fixture modules; no spec per case/category or custom discovery. Creator code uses the real module/public helpers, queries its initialized factory for the actual catalog OID and retains credential-free TestDatabaseInfo/OID privately. For retained-target coverage, the parent deliberately terminates that exact child after saved acquisition and waits for exit/disconnection before launching a distinct ordinary Node recovery process. Do not call normal close/reset before that termination, mutate private state or override PID. Separately prove a creator that completes normal teardown exits naturally and fresh recovery returns already-absent. Recovery success and failure children must exit naturally; parent timeouts fail the test before terminating only their own stuck child. The recovery process imports the public built package subpath; add declaration smoke coverage using that same import.

Native PostgreSQL coverage must prove exact removal and already-absent retry; malformed/no-OID/name/base/role/owner/OID refusal; long UTF-8/quoted names; renamed target and same-name replacement preserved; connected-target refusal; a concurrent live sibling and its sentinel preserved; concurrent recoveries; recovery during setup/active use/clear/close/recreate; lease loss and partial setup/teardown failures; and natural passing/failing child exits. Include non-superuser direct-owner checks on a harness-owned disposable role. Own and explicitly clean up any test roles/resources; do not use elevated roles in the recovery operation.

Use real server barriers to exercise lock contention and statement deadlines. At the public API/driver boundary, inject lost DROP responses, post-DROP lookup failures, connect/query stalls and close failures; combine native postcondition checks with fault injection where a network uncertainty cannot be reproduced reliably. Cancellation must cover preconnect, pre-DROP and post-dispatch. Assert no late DROP after pre-dispatch cancellation, bounded settlement, retained uncertainty, all connections/leases released and no unhandled promises. Do not claim mocked behavior as native recovery proof.

Keep normal setup/reset/migration and production/CLI regression tests. CI must build before the public compiled-subpath child smoke and must fail if DATABASE_URL is absent or native scenarios skip. Local absence may visibly skip native tests, but cannot count as acceptance. Fixtures must remain excluded from dist. Public evidence includes commands, input hashes/commit, server ownership, counts, outcomes, durations and natural exit statuses. Names, OIDs, connection material, private journals and raw errors stay in restricted scratch, never PRs, committed evidence or logs.

## Risks / Trade-offs

- A base session per active invocation consumes one extra connection → document capacity, reuse that session for administration, and verify release on every path.
- Uncooperative DDL can replace a checked name → require caller exclusivity, recheck under the shared lock and refuse when exclusivity is unknown. This is a stated support boundary, not atomic OID deletion.
- Old workers do not hold the lock → require stopped creators and exclusive targets for retained records; incomplete evidence stays failed pending manual verification by its owner.
- Transport failure can hide a committed DROP → preserve uncertainty, close within budget and support a later explicit idempotent retry.
- Driver timeouts and end behavior vary → constrain the supported pg peer range, verify the installed implementation and public boundary. A mismatch goes to Founding Engineer; do not weaken cleanup guarantees or reach into private driver state.

## Migration Plan

Keep this issue's harness branch and one draft feature PR through apply, simplify and review. The existing names, TestDatabaseInfo shape, `forRoot`, `forTest`, setup, clear, close and reset APIs remain compatible. The new API adds explicit inputs without acquiring from a planned name. No stronger record format is introduced. If implementation proves stronger evidence necessary, stop for Founding Engineer direction; any replacement descriptor must be versioned and old unsupported records must fail explicitly.

The database README must show: resolve independent configuration with ConfigService; set up using the existing module; save original info and observed OID in a restricted record; establish creator exit/exclusive target; invoke recoverTestDatabase from a fresh process; retain prior failures; remove a journal only after confirmed success and durable journal update. Journal persistence and archive recovery remain consumer responsibilities. No test-only env names or process.env mutation inside specs.

Reviewer checks the final sensitive surfaces, archives completed OpenSpec artifacts on the same branch where appropriate, and merges under standing policy. Reviewer returns the same open issue to Founding Engineer in_progress. Founding Engineer verifies actual semantic-release CI, the npm version/declarations/subpath/recipe and immutable PR/merge commit before completion. A pending release uses a bounded machine monitor; failure remains actionable. No predicted version, direct main push, manual publication, unpublished consumer install or new credentials. Rollback uses a reviewed upstream revert and the same release workflow.

## Open Questions

No product approval is pending. Applier must verify pg interruption/close behavior and lease-loss handling against the installed driver before proceeding to full coverage. If a public driver path cannot meet the bounds, return the concrete mismatch to Founding Engineer rather than adding driver-private manipulation or relaxing the contract.
