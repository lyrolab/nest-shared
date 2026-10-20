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
interface TestDatabaseRecoveryTls {
  readonly caPem: string
  readonly certPem?: string
  readonly keyPem?: string
}

interface TestDatabaseRecoveryBase {
  readonly databaseUrl: string
  readonly expectedRole: string
  readonly tls?: TestDatabaseRecoveryTls
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

The caller resolves the normal `DATABASE_URL` through ConfigService and supplies it independently of the retained record. `expectedRole` is its independently allowed disposable role. Require an explicit PostgreSQL URL host, user and base database; decoded URL user must equal expectedRole. Prevent connection-string overrides or implicit PG environment defaults from changing that binding. Apply the recovery-only TLS rules below. Validate the actual connection as described below; URL parsing alone cannot prove provenance.

The function neither reads nor changes the current static invocation, options, sources or configuration. A failed or successful recovery cannot reset a sibling context. A separate function is simpler than an adoption method that populates process-local ownership.

Do not add a new secret, acquisition token or descriptor format. Original `TestDatabaseInfo` plus a positively observed acquired OID remains the evidence contract. Records containing only a planned name or missing OID fail. Caller evidence is trusted input, not authentication; the caller must protect its records and validate host/port/base, role and source-versus-target purpose independently. Do not fabricate acquisition evidence by looking up an arbitrary existing name.

### 1a. Explicit in-memory recovery TLS

The caller loads material independently before invoking recovery. `base.tls` accepts only the three own string fields above: a nonempty PEM CA bundle and either both client certificate/key PEM strings or neither. Each string must be valid Unicode, NUL-free and at most 1,048,576 UTF-8 bytes; the total cannot exceed 3,145,728 bytes. Reject empty/malformed PEM, mismatched certificate/key, encrypted keys requiring a passphrase, unknown fields, buffers, arrays, callbacks, caller sockets and broad driver/TLS options. Capture every field as a private primitive before the first await. Reassigning caller properties afterward cannot change trust or client identity. Use Node's public secure-context validation and pg's TLS wrapping; never implement certificate parsing or authentication.

Refuse `sslrootcert`, `sslcert` and `sslkey` URL parameters, including empty, duplicated or percent-encoded spellings, before any filesystem, Client or socket creation. Their presence always refuses, even with `sslmode=disable` or valid in-memory material. Do not give the URL to pg's connection-string parser. Parse explicit identity fields and pass an explicit Client config with no `connectionString`. Reject unknown/duplicate query keys and alternate casing rather than letting driver defaults interpret them. Accept only the following mode combinations:

| URL sslmode                     | base.tls absent                 | Valid base.tls present                   |
| ------------------------------- | ------------------------------- | ---------------------------------------- |
| Absent                          | Plain TCP, explicitly ssl=false | TLS with full peer/hostname verification |
| disable                         | Plain TCP, explicitly ssl=false | INVALID_INPUT                            |
| require, verify-ca, verify-full | INVALID_INPUT                   | TLS with full peer/hostname verification |
| Other, empty or duplicated      | INVALID_INPUT                   | INVALID_INPUT                            |

`require` and `verify-ca` do not relax hostname verification in this API. Explicit CA material is required for TLS; there is no ambient trust-file acquisition, implicit pg configuration, downgrade or plaintext retry. Disable direct negotiation and keep SSLRequest with pg ^8.23.1. Never accept `rejectUnauthorized`, `checkServerIdentity` or `servername` from the caller. Endpoint identity derives from the independently supplied base URL, including IP SAN verification for an IP URL. A DNS URL must retain that DNS identity even if a separately prepared numeric endpoint is selected; its supported preparation contract remains subject to decision 1b.

Input conflicts and malformed material report fixed INVALID_INPUT/validate/not-attempted without private details or a client/socket. Unknown CA and wrong peer identity fail during verified connect and use the existing safe DATABASE_FAILURE and cleanup reporting. The operation starts its original work clock on invocation; preparation is explicitly caller-owned and complete before that call, never a deferred promise whose time is excluded later. No material belongs in TestDatabaseInfo/OID, errors, checkpoints or logs. No acquisition token or record migration is needed.

The supported recipe must show caller-owned loading before invocation, independent ConfigService/DATABASE_URL and expected role, and deliberate reconstruction of an equivalent explicit URL without file parameters. The caller must preserve host, port, user/password and decoded base and carry the same trust/client identity into `base.tls`. Do not offer an automatic file-parameter stripper or interpret a path as PEM. Loading has its own caller-owned timeout/cancellation/cleanup; timeoutMs does not cover it.

Keep normal forRoot/forTest/setup/reset TLS URL behavior. Separate recovery capture/config construction from the normal lifetime-lease path narrowly; common identity and owned-transport mechanics remain shared. This recovery-only restriction cannot become a new preparation requirement for existing normal callers. Prove normal TLS setup, active lease and teardown with supported certificate URLs.

### 1b. Connection preparation prerequisite: unresolved

The [connection acquisition audit](verification/queued-connection.md) establishes a further mismatch on the unchanged public API. A real DNS lookup remains pending after recovery returns. More critically, pg's SCRAM WebCrypto key derivation remains pending and starts more crypto operations after return, even with a literal IP and no certificate files. Closing the socket and settling Client.connect/end do not settle all recovery-started work. Waiting for that work can exceed work+close budgets under unrelated pool contention. The accepted guarantee therefore cannot be declared satisfied by preloading TLS alone.

Founding Engineer must select a supported isolation or connection-preparation boundary, or route an upstream driver capability, before the remaining implementation tasks proceed. Caller-prepared numeric address selection can address queued lookup only if it preserves the URL's TLS DNS/IP identity and independent endpoint binding; it does not resolve SCRAM. Do not invent a final resolution/preparation type until that boundary can meet the whole contract. A reusable prepared connection also needs explicit ownership, lifetime and loss validation and must not attach to the retained target or change its evidence record.

No disabling SCRAM, changing server auth, weakening TLS, replacing pg authentication, using driver internals, synchronous crypto, worker-pool resizing or promise racing away from unfinished work is authorized. A public caller must still use ordinary Node/Jest/Vitest and exit naturally. Internal isolation, if selected, must be owned, bounded and joined before return rather than detached; a process-wide exit requirement remains forbidden. Return this concrete mismatch to Founding Engineer instead of handing an incomplete closure design to Applier.

### 2. Reuse the exact existing name calculation

Extract a private pure helper used by both `getTestDatabaseInfo` and recovery. Preserve SHA-256 over `JSON.stringify([decodedBaseName, namespace, processId, workerId])`, the first 32 hexadecimal digits, `_test_` suffix and prefix truncation at UTF-8 code-point boundaries to at most 63 bytes. Preserve identifier quoting and URL path encoding. No new naming version or current-process substitution.

Validate runtime input types before network work. Require nonempty, NUL-free namespace/name; string worker ID, including the existing valid empty string; positive safe-integer creator PID; and positive integer OID within PostgreSQL's unsigned 32-bit range. Reject invalid Unicode, malformed URL/encoding, empty base, overlong target, nonfinite deadlines, unsupported record shapes and recomputed-name mismatch. Read/copy validated primitive inputs once so caller mutation during awaits cannot change the target.

Refuse targets equal to the decoded base, actual current database, `postgres`, `template0`, `template1`, or PostgreSQL-reserved `pg_` names. Refuse catalog-marked templates even with another name. Validate all available evidence before treating absence as idempotence.

### 3. Pin one base session for the ownership check and DROP

Use the existing PostgreSQL driver through public `pg.Client` configuration, methods and events. Declare optional peer `pg: "^8.23.1"`, keep the development dependency/lock and add development types. The floor is the tested 8.23.1 factory/TLS implementation, not the first version that accepted a factory (8.9.0). Later compatible 8.x versions still need the transport regressions; do not lower the floor without equivalent proof. Load pg and Node networking lazily when database administration is invoked so other module imports do not require the driver. Keep TypeORM/Nest for application/factory composition.

The private administration helper creates and retains a fresh `net.Socket` before constructing Client, then passes `stream: () => ownedSocket`. That public factory is the only transport injection point. The helper owns this socket and its close/error observers throughout connect, active use and cleanup. Never retrieve `client.connection.stream`, inspect driver-private state, patch pg, send a dummy query to change its shutdown path, unref the socket or delegate cleanup to a detached process. No pool, reconnect, automatic retry or SET ROLE.

Keep pg responsible for SSLRequest, TLS wrapping and configured certificate/hostname validation. Supply the owned plaintext socket to pg; do not pre-wrap it or recreate TLS negotiation. Recovery passes captured in-memory PEM under decision 1a; normal lifecycle callers retain their supported TLS URL behavior. Never set `rejectUnauthorized: false` as a workaround. The supported transport is ordinary Node TCP with pg's default PostgreSQL SSLRequest negotiation. Reject direct negotiation, custom/caller streams, Unix sockets and alternate runtimes in this API until separately proven; never silently downgrade TLS or fall back to ambient negotiation settings. Those bounds apply only to the private administration helper, not production `forRoot` configuration. The durable [transport prerequisite](verification/README.md) proves the chosen path through public interfaces with local fixtures, including DNS/IP certificate acceptance and rejection.

The session sequence is:

1. Validate/capture input and check cancellation/deadline before connect.
2. Connect to the explicit base. Query `current_database()`, `session_user`, `current_user` and their catalog identity. Require the decoded base and expectedRole to match, with current and session role equal. Require exactly one matching non-template base catalog row.
3. Acquire the target's session advisory lock using `pg_try_advisory_lock`. Contention returns a busy failure; never steal or wait indefinitely.
4. Query the exact target name with parameters. Validate unique row, exact saved OID, direct owner OID equal to the connecting role's OID, non-template status and allowed target name. Role membership or superuser powers do not substitute for direct ownership. Never enumerate names by prefix.
5. If no exact-name row exists, also look up the saved OID. A saved OID found under another name is an identity mismatch, not absence. If neither exists, record already-absent. Present targets with mismatched evidence fail without DROP.
6. Immediately before DROP, check cancellation/deadline, session health and identity again while holding the same lock. Issue only `DROP DATABASE <quoted exact name>`, with neither FORCE nor IF EXISTS. A connected peer makes ordinary DROP fail. Never terminate it or repair the database.
7. After acknowledged DROP, verify exact-name absence and that the saved OID has not moved to another name. Any remaining/replacement row fails. Return removed only after successful close.
8. On every path, close the newly opened client and its owned transport within decision 5. Observe every started connect/query/end promise and local close; clear timers/listeners after disposal. Preserve every close failure alongside the primary failure. Local closure does not establish when a partitioned server releases its session lock.

OID lookup catches a rename but does not make deletion OID-addressed. PostgreSQL accepts a name for DROP, refuses connected targets without FORCE and forbids DROP inside a transaction. A transaction or `SELECT ... FOR UPDATE` cannot provide the required atomic operation. See [PostgreSQL 16 DROP DATABASE](https://www.postgresql.org/docs/16/sql-dropdatabase.html).

### 4. Protect the whole cooperating lifecycle

Use a private shared session-lock helper, not a second database manager. Compute one stable signed 64-bit lock key from the first eight SHA-256 bytes of `JSON.stringify(["@lyrolab/nest-shared/test-database", databaseName])`. All participants connect to the same explicit base; do not include role, PID or acquired OID in the lock key. A hash collision only refuses unrelated work.

Normal setup acquires the same lock on a dedicated base session before CREATE. Retain that session through OID capture, schema initialization, active use, clear, closure of both TypeORM owners, owned DROP and verified teardown. Reuse it for administration instead of creating a separate competing administration path. It stays separate from target connections so closing the target cannot expose a gap before DROP. Release/close it last using the same owned-transport helper and bounded disposal as recovery. Existing in-process busy/setup-promise guards remain.

This lifetime lock also covers initialization windows with no target connection, close/recreate with the same identity and module realms using a shared identity. Another recovery cannot delete a healthy active invocation. Two recoveries contend on the same key; a later explicit retry can observe absence. Different targets, including a sibling with a live sentinel, remain independent.

On setup failure, retain the lease until partial sources and owned database cleanup are resolved. A pre-CREATE failure grants no ownership. On close failure retain retry state and reject new setup/reset. On unexpected lease-session loss, mark the normal context unsafe: stop further clear/setup and never issue DDL on a replacement session without reacquiring the same lock and revalidating the saved OID. A retry must preserve ownership/cleanup state, including the case where DROP succeeded but lease close failed. Do not leave an unhandled client error or silently report teardown success.

A local socket close marks the lease unusable immediately; it does not prove immediate remote session death during a network partition. A retry uses a fresh session and `pg_try_advisory_lock`; continued server-side contention stays BUSY, with no forced unlock or peer termination. Session advisory locks coordinate participating code and are released by the server when a session ends; outside code is not forced to honor them. See [PostgreSQL advisory locks](https://www.postgresql.org/docs/16/explicit-locking.html#ADVISORY-LOCKS). This design uses no deployment catalog locks, catalog writes, extension, persistent lock table or locking service.

The lock protocol does not retroactively cover an old library process. Callers recovering an existing saved record must first stop that creator and exclude all other DDL for the target. If that prerequisite is unknown, or the lock/session/identity checks cannot be maintained, refuse. Do not describe SELECT plus DROP as atomic against arbitrary outside DDL. No automatic API can authenticate a forged record or defeat an administrator that ignores the protocol.

### 5. Bound work and preserve what is known

`timeoutMs` defaults to 30,000 and bounds the entire work phase, including connect, inspection, lock and verification. `closeTimeoutMs` defaults to 5,000 and separately bounds mandatory cleanup, so total elapsed time is bounded by their sum plus event-loop scheduling. Accept positive integer values up to 300,000 and 30,000 respectively. Reject invalid values. Cancellation never skips close or grants a fresh work budget.

Use a monotonic remaining work budget, native `connectionTimeoutMillis`, `statement_timeout`, `lock_timeout` and `query_timeout`, capped to remaining work. Check cancellation before every operation and immediately before destructive dispatch. Serialize queries and never queue DROP behind a timed-out inspection. A stopped flag is set synchronously on abort/deadline/connection failure and checked by every continuation before dispatch; no later connect/query completion can resume work. Observe each started promise immediately, including rejections after interruption. Handle asynchronous client/socket error events without logging server fields.

Mandatory close has one monotonic deadline. Reserve the final half of `closeTimeoutMs` for forced disposal and confirmation; the graceful interval is `floor(closeTimeoutMs / 2)` (zero for a 1 ms budget). Install owned-socket close and public Client end/error observers before connecting. On normal completion or a non-transport validation failure, start public `client.end()` and allow only the graceful interval. A rejection or expiry records CLOSE_FAILED, then calls `ownedSocket.destroy()` immediately. Do not start a second close budget or report success because destruction subsequently works. Repeated close uses the captured completion state rather than assuming another `end()` fixes the transport.

On cancellation, work deadline or transport failure, stop dispatch first, dispose the owned socket immediately, and observe `client.end()` without waiting for the graceful interval. During an unfinished connect, destroy with a fixed local Error so pg rejects its connect promise; silent socket destruction after marking Client as ending can suppress that rejection. No raw driver error becomes a public cause. An intentional interruption is the primary CANCELLED/DEADLINE_EXCEEDED/DATABASE_FAILURE; successful immediate disposal need not add CLOSE_FAILED. An end rejection, failed disposal, missed graceful deadline or lack of close confirmation always adds CLOSE_FAILED. If close was already in progress, cancellation cannot erase its failure.

Completion requires the owned socket's observed `close` event, the public Client `end` event for a started connection, every started connect/query/end promise, and every recovery-started configuration, resolution and authentication operation to settle within the original work/close budgets plus event-loop scheduling. Pending lookup or crypto work is not disposal, even when the public Client promises settled. Decision 1b remains a blocking prerequisite for this guarantee. A preconnect refusal creates no client/socket. Keep error handlers until all disposal events and pending operations settle, then remove timers, abort listeners and temporary observers. The adapter must retain no live socket, TLS wrapper or cleanup timer after return. `destroyed`, a timeout race and unref alone are not confirmation. If confirmation fails, reject with CLOSE_FAILED and preserve the primary failure; never claim a clean exit. Such an inability is a contract mismatch for Founding Engineer, not permission for implementation to leak resources or require caller `process.exit`.

Closing a transport cannot prove that a submitted DROP did not finish, nor immediately release a remote advisory lock under a network failure. Once DROP dispatch starts, a lost response, cancellation, deadline or failed postcondition leaves an unknown outcome. Never retry DDL automatically. Close failure rejects even after confirmed absence and retains the observed outcome. A bounded private child may provide an additional caller fence, but ordinary API use itself must close its connections and exit naturally, without forceExit, detached cleanup or a process-exit requirement.

The [transport prerequisite](verification/README.md) exercises these public interfaces on pg 8.23.1. Applier must carry its cases into helper/API regressions, including primary plus close failure, lost DROP response and post-disposal dispatch. This probe alone verifies neither recovery nor lifecycle integration. See [Client controls](https://node-postgres.com/apis/client), [8.23.1 connection implementation](https://github.com/brianc/node-postgres/blob/pg%408.23.1/packages/pg/lib/connection.js), [pg TLS configuration](https://node-postgres.com/features/ssl) and [Node socket.destroy](https://nodejs.org/docs/latest-v24.x/api/net.html#socketdestroyerror).

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
- Driver/TLS shutdown behavior can change → keep the tested pg floor and public-interface transport regressions. A mismatch goes to Founding Engineer; do not weaken cleanup guarantees, certificate checks or process-exit proof.

## Migration Plan

Keep this issue's harness branch and one draft feature PR through apply, simplify and review. The existing names, TestDatabaseInfo shape, `forRoot`, `forTest`, setup, clear, close and reset APIs remain compatible. The new API adds explicit inputs without acquiring from a planned name. No stronger record format is introduced. If implementation proves stronger evidence necessary, stop for Founding Engineer direction; any replacement descriptor must be versioned and old unsupported records must fail explicitly.

The database README must show: independently load TLS PEM material, explain its separate caller-owned lifecycle and supply an equivalent explicit URL without certificate paths; resolve independent configuration with ConfigService; set up using the existing module; save original info and observed OID in a restricted record; establish creator exit/exclusive target; invoke recoverTestDatabase from a fresh process; retain prior failures; remove a journal only after confirmed success and durable journal update. Journal persistence and archive recovery remain consumer responsibilities. No test-only env names or process.env mutation inside specs.

Reviewer checks the final sensitive surfaces, archives completed OpenSpec artifacts on the same branch where appropriate, and merges under standing policy. Reviewer returns the same open issue to Founding Engineer in_progress. Founding Engineer verifies actual semantic-release CI, the npm version/declarations/subpath/recipe and immutable PR/merge commit before completion. A pending release uses a bounded machine monitor; failure remains actionable. No predicted version, direct main push, manual publication, unpublished consumer install or new credentials. Rollback uses a reviewed upstream revert and the same release workflow.

## Open Questions

No human response is pending. In-memory PEM and refusal rules are selected. Founding Engineer owns the further DNS/SCRAM acquisition mismatch in decision 1b; implementation cannot resume on a claim that socket disposal settles those operations. The existing socket/TLS proof remains valid within its recorded scope, but is not proof of the full connection boundary. After that correction, Applier must verify the public contract, normal TLS compatibility, cold-process behavior and real pool contention before native recovery acceptance. No private driver access or weaker closure/TLS contract is authorized.
