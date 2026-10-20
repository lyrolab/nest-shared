## Context

`SharedDatabaseModule` derives test names from the decoded base name, namespace, creator PID and worker ID. Successful CREATE records an OID privately. Setup always creates; reset can release only that process's ownership. A recovery process must use original acquisition evidence without initializing another invocation or restoring private static fields.

The existing module, database barrel, README, integration runner and PostgreSQL 16 CI service supply the work sites. Production `forRoot` and CLI configuration are outside the implementation scope. No application schema migration is needed.

## Goals / Non-Goals

**Goals:** remove only an exact retained disposable database; support explicit idempotent retry; coordinate cooperating lifecycle operations; bound recovery and preserve failures; ship a usable public package contract.

**Non-Goals:** database discovery/adoption, prefix cleanup, fixture setup, schema/data operations, consumer journal/archive management, termination of caller/creator/peer processes, production changes or manual publication.

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

The caller loads material independently before invoking recovery. `base.tls` accepts only the three own string fields above: a nonempty PEM CA bundle and either both client certificate/key PEM strings or neither. Each string must be valid Unicode, NUL-free and at most 1,048,576 UTF-8 bytes; the total cannot exceed 3,145,728 bytes. Reject empty/malformed PEM, mismatched certificate/key, encrypted keys requiring a passphrase, unknown fields, buffers, arrays, callbacks, caller sockets and broad driver/TLS options. Capture every field as a private primitive before the first await. Reassigning caller properties afterward cannot change trust or client identity. Perform only bounded shape/PEM-envelope checks in the parent. Validate the secure context and certificate/key pairing inside the child before constructing a client/socket; no native TLS parsing is excluded from the work clock. Use Node's public TLS/X509 interfaces and pg's TLS wrapping; never implement certificate parsing or authentication.

Refuse `sslrootcert`, `sslcert` and `sslkey` URL parameters, including empty, duplicated or percent-encoded spellings, before any filesystem, Client or socket creation. Their presence always refuses, even with `sslmode=disable` or valid in-memory material. Do not give the URL to pg's connection-string parser. Parse explicit identity fields and pass an explicit Client config with no `connectionString`. Reject unknown/duplicate query keys and alternate casing rather than letting driver defaults interpret them. Accept only the following mode combinations:

| URL sslmode                     | base.tls absent                 | Valid base.tls present                   |
| ------------------------------- | ------------------------------- | ---------------------------------------- |
| Absent                          | Plain TCP, explicitly ssl=false | TLS with full peer/hostname verification |
| disable                         | Plain TCP, explicitly ssl=false | INVALID_INPUT                            |
| require, verify-ca, verify-full | INVALID_INPUT                   | TLS with full peer/hostname verification |
| Other, empty or duplicated      | INVALID_INPUT                   | INVALID_INPUT                            |

`require` and `verify-ca` do not relax hostname verification in this API. Explicit CA material is required for TLS; there is no ambient trust-file acquisition, implicit pg configuration, downgrade or plaintext retry. Disable direct negotiation and keep SSLRequest with pg ^8.23.1. Never accept `rejectUnauthorized`, `checkServerIdentity` or `servername` from the caller. Endpoint identity derives from the independently supplied base URL, including IP SAN verification for an IP URL. DNS resolution belongs to the isolated child. The URL host remains the pg/TLS identity; there is no numeric-endpoint preparation contract.

Input conflicts and malformed material report fixed INVALID_INPUT/validate/not-attempted without private details or a client/socket. Unknown CA and wrong peer identity fail during verified connect and use the existing safe DATABASE_FAILURE and cleanup reporting. The operation starts its original work clock on invocation; preparation is explicitly caller-owned and complete before that call, never a deferred promise whose time is excluded later. No material belongs in TestDatabaseInfo/OID, errors, checkpoints or logs. No acquisition token or record migration is needed.

The supported recipe must show caller-owned loading before invocation, independent ConfigService/DATABASE_URL and expected role, and deliberate reconstruction of an equivalent explicit URL without file parameters. The caller must preserve host, port, user/password and decoded base and carry the same trust/client identity into `base.tls`. Do not offer an automatic file-parameter stripper or interpret a path as PEM. Loading has its own caller-owned timeout/cancellation/cleanup; timeoutMs does not cover it.

Keep normal forRoot/forTest/setup/reset TLS URL behavior. Separate recovery capture/config construction from the normal lifetime-lease path narrowly; common identity and owned-transport mechanics remain shared. This recovery-only restriction cannot become a new preparation requirement for existing normal callers. Prove normal TLS setup, active lease and teardown with supported certificate URLs.

### 1b. One library-owned child for the complete recovery session

The public function remains stateless. Launch one private compiled entry, `dist/database/internal/test-database-recovery-child.js`, using `spawn(process.execPath, [absoluteEntry], options)`. Resolve the fixed sibling path relative to the installed module, not cwd or a search/glob. No shell, detached mode, descendants, caller-provided executable or live-connection transfer. Ship this entry in the npm package without adding a public subpath. Normal lifecycle leases stay in their existing owning process; only retained recovery uses isolation.

The parent captures and validates inert caller data, controls time/cancellation, validates protocol messages and constructs public errors/results. It must not initialize pg, resolve hosts, acquire credentials/files, parse native TLS material or authenticate for recovery. Importing the public database entry must still work without optional pg. The child loads only its private engine and needed helpers/pg, not the database barrel, Nest application, migrations or fixtures. Startup, module loading and IPC are part of the invocation work budget. There is no readiness/startup allowance. No in-process fallback if launch fails.

Use `env: {}` on the supported Linux Node runtime, explicit `shell: false`, `detached: false`, no extra runtime flags, and stdio `["ignore", "ignore", "ignore", "ipc"]`. `spawn` avoids fork's inherited execArgv. Do not inherit NODE_OPTIONS, NODE_PATH, inspector/test-runner arguments, loader flags, PG variables, HOME, credential/config-file locations, OpenSSL file overrides, proxy settings or UV_THREADPOOL_SIZE. No connection material goes in argv, environment, temp files, diagnostics or the retained ownership record. Required module resolution comes from packaged relative imports and ordinary installed dependencies. Absolute process.execPath removes PATH lookup. Alternate platforms/environments need equivalent startup/disposal evidence before support; no ambient-config workaround is allowed.

Construct an explicit pg config from the captured URL, with no connectionString. Supply host, port, user, decoded database, ssl, negotiation and the existing safe options explicitly. Preserve explicit empty-password binding through an internal closure over the captured primitive; callers cannot supply callbacks. Empty password must not trigger pgpass/PGPASSWORD. Disable automatic reconnect and alternate transports. The child owns DNS, TLS, SCRAM, the base session, advisory lock, every query, verification and cleanup. Confirmed process disposal contains unfinished native DNS/crypto work; forced termination does not mean its JavaScript promises fulfilled.

Ordinary Node/Jest/Vitest callers must be able to launch and terminate an owned Node child and load its packaged entry. The caller exits naturally. CommonJS require and ESM import of the public database subpath must work from an installed package, including paths with spaces and a cwd outside the checkout. Source-only test loaders/bundlers may not replace the entry with a caller-side execution path. Launch/packaging failures report fixed DATABASE_FAILURE/connect/not-attempted unless permission was already possible; no raw diagnostics. No new public acquisition descriptor or prepared token is required.

### 1c. Small versioned IPC protocol and destructive permission

Use Node's JSON IPC serialization and one invocation per child/channel. Every message has `version: 1` and a literal `type`; reject unexpected fields/types, versions, order, duplicate terminal messages and duplicate permit requests. Each direction has a fixed bounded message count (at most 16) and payload (at most 4 MiB serialized UTF-8). Bound input strings before launch: URL at most 16 KiB, namespace and worker ID at most 64 KiB each, PEM limits from 1a; database/role names retain PostgreSQL byte bounds and existing identity rules. Refuse oversized records with INVALID_INPUT/not-attempted. Capture plain own data properties into fresh records, never serialize caller objects, accessors, callbacks, sockets or the AbortSignal. Caller code/proxy execution is not a supported input preparation mechanism.

Parent → child: `start` (captured primitives/PEM, remaining work and absolute wall-clock work/close ceilings), `permit-drop` (one fixed sequence number), `cancel` (fixed reason and remaining close interval), `close` (remaining graceful/final ceilings), `finish` (acknowledge terminal result and begin channel shutdown). Child → parent: `ready`, `phase` (each phase at most once in allowed order), `request-drop` (sequence 1 only), `closing` (safe work observation/failures; requests the one close transition), `result` (safe result or ordered fixed failure codes/phases/outcome, including cleanup status). No target/role/OID/connection values or driver diagnostics are echoed. The child uses its monotonic elapsed budget capped by parent allowances; neither a phase nor IPC delay can extend the parent's absolute deadlines. Reject expired start messages before any connection. Process lifetime, not a child clock, is the final fence.

The child may request DROP only after acquiring the shared lease and validating actual base/role, direct ownership, name/OID and all target safeguards. It pauses before SQL. The parent checks its live AbortSignal, monotonic deadline, channel state and request sequence. Immediately before calling send(permit-drop), it records possible dispatch and outcome unknown. Even synchronous/asynchronous send failure cannot safely retract that observation. Send completion is not a SQL acknowledgement. Only one permission can ever be issued. Parent interruption revokes future permission immediately; queued/late messages cannot reenable it.

On receiving permission the child checks local stop state, remaining time, session health and target identity again under the same lease. If those checks fail, it sends no DDL. Otherwise it issues the existing ordinary exact-name DROP, acknowledges it internally and verifies exact name/OID absence before reporting removed. The permit is neither atomic SQL cancellation nor atomic deletion by OID. Cancellation may arrive after permission and before SQL, or after SQL has reached PostgreSQL. Until trustworthy subsequent verification, either race remains unknown in the parent. No automatic retry or parent inference from a closed socket is allowed.

| Event order                                                                       | Parent outcome and action                                                                     |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Pre-abort, launch/ready failure, denied request, or child death before permission | not-attempted; no permission can follow interruption                                          |
| Permission send begins, then abort/send error/child crash or result loss          | unknown; dispose child; never infer SQL did not run                                           |
| Child reports a pre-dispatch stop after permission without verification           | unknown; conservative permission fence prevails                                               |
| Valid verified absence without permission                                         | already-absent, subject to result/cleanup/disposal checks                                     |
| Valid acknowledged DROP plus verified absence after permission                    | removed observation; still wait for clean terminal protocol and disposal                      |
| Verified outcome followed by cleanup/exit failure                                 | reject, retaining observed outcome and ordered CLOSE_FAILED                                   |
| Duplicate/malformed/out-of-order messages                                         | fixed DATABASE_FAILURE at last trusted phase, stop permission, dispose; never promote outcome |

One bounded send is allowed per expected transition; observe every send callback and child error. `send() === false` means backpressure, not delivery failure or permission revocation. Never busy-retry or fill the channel. Pending startup/permit/result sends consume the same timeline. Validate results against the parent permission state; removed without permission or impossible phase/failure sequences are protocol errors. A result message alone cannot resolve the public promise. Ignore queued data after stopping except the one expected safe terminal/cleanup result; it cannot erase the parent's earlier failure.

### 1d. Disposal protocol and the parent-loss fence

The parent alone starts close once, on the child's closing message, terminal result, abort, deadline, IPC/protocol failure or child error/exit. Close has the existing single closeTimeoutMs allowance, capped at invocation work deadline plus that allowance. Reserve its final half for forced termination and confirmation. Send close/cancel/finish as appropriate, stop permissions, and allow the child to close its owned transport and observe connect/query/end operations during the graceful half. The child sends closing immediately when work ends, before awaiting transport cleanup; the parent replies with remaining ceilings from this one close transition. For a pending/missing closing message the existing work timer still starts close. Native socket graceful end consumes at most the first quarter of the total close allowance, leaving the next quarter for owned-socket destruction/observation; reserve the final half for process termination/confirmation. All these limits are capped by the same absolute parent close deadline, with no fresh allowance when result or phase changes. The child reports every graceful-close failure even if later local destruction works.

If the child remains live after the graceful half, record CLOSE_FAILED and send SIGKILL through the exact retained ChildProcess handle. Never signal by a saved PID, a reconstructed handle, process group or peer list. Do not signal after observed exit. Join the observed exit event, IPC disconnect event and closure of every configured stdio stream; observe send callbacks/errors too. On the production ignore streams there is no parent pipe to join. ChildProcess close is useful aggregate confirmation but cannot be the only join: the prerequisite on Node 24.13.0 observes no aggregate close after an explicit parent disconnect even though exit, disconnect and both pipe close events occur. Install all individual observers before sending/disconnecting; flags alone are insufficient. A kill return value, killed/destroyed flag, result message, timeout or unref is not proof. Forced exit is intentional disposal of the isolated work, not natural completion or promise settlement. It preserves the primary CANCELLED/DEADLINE_EXCEEDED/DATABASE_FAILURE and appends CLOSE_FAILED; it never changes unknown to not-attempted/success. Normal complete children disconnect and exit naturally after finish.

The child separates terminal work state from process disposal. Install channel/error observers before readiness; keep them effective during acquisition, result, finish and disconnect. A result, finish, successful Client end or socket close cannot disable emergency disposal. Channel loss always stops dispatch and interrupts the owned session, including after terminal work. Keep the message validator active through shutdown so a duplicate finish or other invalid event follows the same emergency path. No beforeExit handler may remove protection.

Use one child-owned emergency self-SIGKILL timer. Arm it before sending the terminal result and before terminal channel shutdown, or immediately on earlier parent loss/error. Its deadline is the minimum of any existing fence deadline, the current absolute close ceiling and now plus the reserved half of closeBudget. Repeated events can shorten that deadline; they cannot restart or extend it. A newly received earlier close ceiling must shorten an armed fence. Before start, use the existing bounded pre-start allowance; after start use the captured parent ceilings. Reserve confirmation time within the original close allowance; no result, finish or disconnect starts a fresh allowance. If the timer must move earlier, replace it with one earlier timer; otherwise retain it. Keep it armed across result, finish and IPC disconnect until actual process exit.

Only this dedicated child's emergency timer may call Timeout.unref(). This narrow exception allows an otherwise clean child to exit naturally while queued native DNS/SCRAM keeps a stuck child alive until self-SIGKILL. It does not establish disposal. Do not unref ChildProcess, IPC, sockets, parent timers or any other resource. An exit listener may synchronously clear the emergency timer; it cannot perform async cleanup or certify termination to another process. The parent still uses referenced supervision and joins observed exit, IPC/stdio closure and started sends. A terminal result never authorizes API return before that join. Forced termination, including child self-SIGKILL after a result, preserves ordered primary plus CLOSE_FAILED for a live caller, and can never produce clean success.

The private entry signals only its own current PID with process.kill(process.pid, "SIGKILL"), never a saved/caller-supplied PID, peer or descendant. Public process.exit() is insufficient for this fence on the measured queued-crypto input. No caller process-exit requirement, detached cleanup or background recovery is allowed. Before start, channel loss must refuse without loading pg and retain emergency protection until exit. Parent death after result-before-finish, finish receipt or disconnect must leave the fence intact. Local termination neither unsends permission nor proves remote lock release/absence. Possible DROP permission retains unknown unless trustworthy verification supports a more precise outcome.

The support boundary requires Node's process termination/channel events within the reserved interval on supported Linux/Node. A concrete inability to confirm disposal is a blocking design mismatch: join the owned child, record the failed bound and return evidence to Founding Engineer, never race away or report bounded success. Event-loop/OS scheduling applies; no real-time OS guarantee exists. Node documents the timer-liveness behavior in [Timeout.unref](https://nodejs.org/docs/latest-v24.x/api/timers.html#timeoutunref) and synchronous-only [exit handlers](https://nodejs.org/docs/latest-v24.x/api/process.html#event-exit).

Clear parent timers, AbortSignal listeners, channel/error/exit observers and captured secret references only after child disposal and started send completion. Keep error observers until then. A confirmed child exit disposes its resolution/authentication resources but cannot prove immediate remote lock release or an unknown DROP outcome; a later recovery still reacquires the server lease and validates catalogs. The prerequisite report `verification/isolated-connection.md` separates local interface evidence from implemented API/native acceptance.

### 2. Reuse the exact existing name calculation

Extract a private pure helper used by both `getTestDatabaseInfo` and recovery. Preserve SHA-256 over `JSON.stringify([decodedBaseName, namespace, processId, workerId])`, the first 32 hexadecimal digits, `_test_` suffix and prefix truncation at UTF-8 code-point boundaries to at most 63 bytes. Preserve identifier quoting and URL path encoding. No new naming version or current-process substitution.

Validate runtime input types before network work. Require nonempty, NUL-free namespace/name; string worker ID, including the existing valid empty string; positive safe-integer creator PID; and positive integer OID within PostgreSQL's unsigned 32-bit range. Reject invalid Unicode, malformed URL/encoding, empty base, overlong target, nonfinite deadlines, unsupported record shapes and recomputed-name mismatch. Read/copy validated primitive inputs once so caller mutation during awaits cannot change the target.

Refuse targets equal to the decoded base, actual current database, `postgres`, `template0`, `template1`, or PostgreSQL-reserved `pg_` names. Refuse catalog-marked templates even with another name. Validate all available evidence before treating absence as idempotence.

### 3. Pin one base session for the ownership check and DROP

Use the existing PostgreSQL driver through public `pg.Client` configuration, methods and events. Declare optional peer `pg: "^8.23.1"`, keep the development dependency/lock and add development types. The floor is the tested 8.23.1 factory/TLS implementation, not the first version that accepted a factory (8.9.0). Later compatible 8.x versions still need the transport regressions; do not lower the floor without equivalent proof. Load pg and Node networking lazily in the session owner; recovery loads them only in its private child so public imports do not require the driver. Keep TypeORM/Nest for application/factory composition.

The private administration helper creates and retains a fresh `net.Socket` before constructing Client, then passes `stream: () => ownedSocket`. That public factory is the only transport injection point. The helper owns this socket and its close/error observers throughout connect, active use and cleanup. Never retrieve `client.connection.stream`, inspect driver-private state, patch pg, send a dummy query to change its shutdown path, unref the socket or delegate cleanup to a detached process. No pool, reconnect, automatic retry or SET ROLE.

Keep pg responsible for SSLRequest, TLS wrapping and configured certificate/hostname validation. Supply the owned plaintext socket to pg; do not pre-wrap it or recreate TLS negotiation. Recovery passes captured in-memory PEM under decision 1a; normal lifecycle callers retain their supported TLS URL behavior. Never set `rejectUnauthorized: false` as a workaround. The supported transport is ordinary Node TCP with pg's default PostgreSQL SSLRequest negotiation. Reject direct negotiation, custom/caller streams, Unix sockets and alternate runtimes in this API until separately proven; never silently downgrade TLS or fall back to ambient negotiation settings. Those bounds apply only to the private administration helper, not production `forRoot` configuration. The durable [transport prerequisite](verification/README.md) proves the chosen path through public interfaces with local fixtures, including DNS/IP certificate acceptance and rejection.

The session sequence is:

1. Validate/capture input and check cancellation/deadline before connect.
2. Connect to the explicit base. Query `current_database()`, `session_user`, `current_user` and their catalog identity. Require the decoded base and expectedRole to match, with current and session role equal. Require exactly one matching non-template base catalog row.
3. Acquire the target's session advisory lock using `pg_try_advisory_lock`. Contention returns a busy failure; never steal or wait indefinitely.
4. Query the exact target name with parameters. Validate unique row, exact saved OID, direct owner OID equal to the connecting role's OID, non-template status and allowed target name. Role membership or superuser powers do not substitute for direct ownership. Never enumerate names by prefix.
5. If no exact-name row exists, also look up the saved OID. A saved OID found under another name is an identity mismatch, not absence. If neither exists, record already-absent. Present targets with mismatched evidence fail without DROP.
6. For recovery, request and receive parent permission under decision 1c. Immediately before DROP, check cancellation/deadline, session health and identity again while holding the same lock. Issue only `DROP DATABASE <quoted exact name>`, with neither FORCE nor IF EXISTS. A connected peer makes ordinary DROP fail. Never terminate it or repair the database.
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

`timeoutMs` defaults to 30,000 and starts at public invocation before capture. It bounds capture, launch, child startup/module loading, IPC, DNS/TLS/authentication, connect, inspection, lock and verification. `closeTimeoutMs` defaults to 5,000 and separately bounds mandatory cleanup, so total elapsed time is bounded by their sum plus event-loop scheduling. Accept positive integer values up to 300,000 and 30,000 respectively. Reject invalid values. Cancellation never skips close or grants a fresh work budget.

Use a monotonic remaining work budget, native `connectionTimeoutMillis`, `statement_timeout`, `lock_timeout` and `query_timeout`, capped to remaining work. Check cancellation before every operation and immediately before destructive dispatch. Serialize queries and never queue DROP behind a timed-out inspection. A stopped flag is set synchronously on abort/deadline/connection failure and checked by every continuation before dispatch; no later connect/query completion can resume work. Observe each started promise immediately, including rejections after interruption. Handle asynchronous client/socket error events without logging server fields.

The normal session helper's mandatory close has one monotonic deadline. In recovery it receives only the child's remaining graceful allocation under 1d; the parent reserves the final half for process termination. Within the session helper allocation, reserve the final half for owned-socket disposal and confirmation; the graceful interval is `floor(closeTimeoutMs / 2)` (zero for a 1 ms budget). Install owned-socket close and public Client end/error observers before connecting. On normal completion or a non-transport validation failure, start public `client.end()` and allow only the graceful interval. A rejection or expiry records CLOSE_FAILED, then calls `ownedSocket.destroy()` immediately. Do not start a second close budget or report success because destruction subsequently works. Repeated close uses the captured completion state rather than assuming another `end()` fixes the transport.

On cancellation, work deadline or transport failure, stop dispatch first, dispose the owned socket immediately, and observe `client.end()` without waiting for the graceful interval. During an unfinished connect, destroy with a fixed local Error so pg rejects its connect promise; silent socket destruction after marking Client as ending can suppress that rejection. No raw driver error becomes a public cause. An intentional interruption is the primary CANCELLED/DEADLINE_EXCEEDED/DATABASE_FAILURE; successful immediate disposal need not add CLOSE_FAILED. An end rejection, failed disposal, missed graceful deadline or lack of close confirmation always adds CLOSE_FAILED. If close was already in progress, cancellation cannot erase its failure.

Natural session completion requires the owned socket's observed close event, public Client end for a started connection and every started operation to settle. Recovery additionally requires confirmed child disposal under 1d within the same parent timeline. Pending DNS/crypto may be disposed by confirmed termination of that isolated process; do not call those interrupted promises fulfilled. Socket/Client events alone do not establish disposal of that work. A preconnect refusal creates no client/socket. Keep error handlers until all disposal events and pending operations settle, then remove timers, abort listeners and temporary observers. The adapter must retain no live socket, TLS wrapper or cleanup timer after return. `destroyed`, a timeout race and unref alone are not confirmation. If confirmation fails, reject with CLOSE_FAILED and preserve the primary failure; never claim a clean exit. Such an inability is a contract mismatch for Founding Engineer, not permission for implementation to leak resources or require caller `process.exit`.

Closing a transport cannot prove that a submitted DROP did not finish, nor immediately release a remote advisory lock under a network failure. Once DROP dispatch starts, a lost response, cancellation, deadline or failed postcondition leaves an unknown outcome. Never retry DDL automatically. Close failure rejects even after confirmed absence and retains the observed outcome. The private child is mandatory for recovery; ordinary caller success/failure exits naturally, without forceExit, detached cleanup or a caller process-exit requirement.

The [transport prerequisite](verification/README.md) exercises these public interfaces on pg 8.23.1. Applier must carry its cases into helper/API regressions, including primary plus close failure, lost DROP response and post-disposal dispatch. This probe alone verifies neither recovery nor lifecycle integration. See [Client controls](https://node-postgres.com/apis/client), [8.23.1 connection implementation](https://github.com/brianc/node-postgres/blob/pg%408.23.1/packages/pg/lib/connection.js), [pg TLS configuration](https://node-postgres.com/features/ssl) and [Node socket.destroy](https://nodejs.org/docs/latest-v24.x/api/net.html#socketdestroyerror).

Export `TestDatabaseRecoveryError extends Error` with safe fixed message and these readonly fields:

- `code`: `INVALID_INPUT | UNSAFE_TARGET | IDENTITY_MISMATCH | OWNERSHIP_MISMATCH | BUSY | CANCELLED | DEADLINE_EXCEEDED | DATABASE_FAILURE | CLOSE_FAILED`.
- `phase`: `validate | connect | lock | inspect | drop | verify | close`.
- `outcome`: `not-attempted | unknown | removed | already-absent`.
- `failures`: ordered `{ code, phase }` entries retaining the primary failure and all cleanup failures. The primary failure supplies the top-level code/phase; a close-only failure uses CLOSE_FAILED.

`not-attempted` means DROP permission was never granted. Set unknown conservatively before the parent attempts to send permission; promote to removed only after acknowledgement and verified absence, or to already-absent after validated catalog absence. A close failure retains that observation but still rejects. Never attach raw driver errors, connection options, names, OIDs or credentials as enumerable fields or cause. Safe error codes preserve each failure without publishing its server text. A subsequent already-absent result does not erase the caller's prior failure.

### 6. Prove acquisition and recovery through public boundaries

Extend the colocated database runners with scenario data and fixture modules; no spec per case/category or custom discovery. Creator code uses the real module/public helpers, queries its initialized factory for the actual catalog OID and retains credential-free TestDatabaseInfo/OID privately. For retained-target coverage, the parent deliberately terminates that exact child after saved acquisition and waits for exit/disconnection before launching a distinct ordinary Node recovery process. Do not call normal close/reset before that termination, mutate private state or override PID. Separately prove a creator that completes normal teardown exits naturally and fresh recovery returns already-absent. The ordinary recovery caller processes must exit naturally; internal library children either complete naturally or are explicitly reported as forced disposal; parent timeouts fail the test before terminating only their own stuck child. The recovery process imports the public built package subpath; add declaration smoke coverage using that same import.

Native PostgreSQL coverage must prove exact removal and already-absent retry; malformed/no-OID/name/base/role/owner/OID refusal; long UTF-8/quoted names; renamed target and same-name replacement preserved; connected-target refusal; a concurrent live sibling and its sentinel preserved; concurrent recoveries; recovery during setup/active use/clear/close/recreate; lease loss and partial setup/teardown failures; and natural passing/failing child exits. Include non-superuser direct-owner checks on a harness-owned disposable role. Own and explicitly clean up any test roles/resources; do not use elevated roles in the recovery operation.

Use real server barriers to exercise lock contention and statement deadlines. At the public API/driver boundary, inject lost DROP responses, post-DROP lookup failures, connect/query stalls and close failures; combine native postcondition checks with fault injection where a network uncertainty cannot be reproduced reliably. Cancellation must cover preconnect, pre-DROP and post-dispatch. Assert no late DROP after pre-dispatch cancellation, bounded settlement, retained uncertainty, all connections/leases released and no unhandled promises. Do not claim mocked behavior as native recovery proof.

Keep normal setup/reset/migration and production/CLI regression tests. CI must build before the public compiled-subpath child smoke and must fail if DATABASE_URL is absent or native scenarios skip. Local absence may visibly skip native tests, but cannot count as acceptance. Test fixtures remain excluded from dist; the private production child entry must be included and exercised from a packed install with CommonJS/ESM public imports. Public evidence includes commands, input hashes/commit, server ownership, counts, outcomes, durations and natural exit statuses. Names, OIDs, connection material, private journals and raw errors stay in restricted scratch, never PRs, committed evidence or logs.

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

No human response is pending. In-memory PEM, the owned-process boundary and the conservative permission protocol are selected. Applier must port the prerequisite cases to the actual public-package child boundary, verify packed entry/import behavior and normal TLS compatibility, and rerun affected native coverage and final-head CI. Existing parent-side pg mocks cannot prove child behavior. A concrete platform/startup/disposal mismatch returns to Founding Engineer; no in-process fallback or weaker TLS/cleanup guarantee is authorized.
