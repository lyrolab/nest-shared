# retained-test-database-recovery Specification

## Purpose

Define exact recovery of retained disposable test databases from original acquisition evidence, with independent connection binding, bounded cleanup, conservative failure outcomes and public-package verification.

## Requirements

### Requirement: Public recovery from original acquisition evidence

The database subpath SHALL export `recoverTestDatabase`, `RecoverTestDatabaseOptions`, `TestDatabaseRecoveryBase`, `TestDatabaseRecoveryResult` and `TestDatabaseRecoveryError`. The operation SHALL accept original TestDatabaseInfo, a positive acquired OID, independent explicit base configuration, exclusive-target assertion and bounded timeout/cancellation controls. It SHALL work in an ordinary fresh Node/Jest/Vitest process without initializing or mutating a static invocation.

#### Scenario: Creator stops before cleanup

- **WHEN** a creator acquires a database through the public module, saves its info and observed OID, and is terminated before teardown
- **THEN** a distinct recovery process with independently validated base/role and exclusive control removes only that target and exits naturally
- **AND** it requires no orchestration identity, PID override, private state mutation or fixture setup

#### Scenario: Evidence is incomplete or unsupported

- **WHEN** the record lacks a positive acquired OID, required identity or exclusive-target assertion, or has malformed/unsupported fields
- **THEN** recovery rejects before DDL and never infers acquisition from a planned name
- **AND** it does not invent missing evidence or require a new unversioned secret

### Requirement: Exact original naming and independent connection binding

Recovery SHALL use the same name derivation, UTF-8 63-byte bound and quoting rules as normal setup with the original namespace, worker ID and creator PID. It SHALL validate the actual base database and connecting session/current role against independent configuration. It SHALL refuse base/current/system/reserved/template targets, inconsistent identity and indirect ownership.

#### Scenario: Fresh process has another PID and worker

- **WHEN** recovery runs under a different PID/worker from the creator
- **THEN** the original name is recomputed from saved identity without substituting the recovery identity
- **AND** existing empty worker IDs, quoted bases and long Unicode prefixes remain compatible

#### Scenario: Binding or ownership does not match

- **WHEN** recomputed name, actual base, configured role, session role, target owner or saved OID differs
- **THEN** recovery rejects and preserves the database and its sentinel
- **AND** membership or elevated privileges do not substitute for direct ownership

#### Scenario: Same name belongs to a replacement

- **WHEN** an external actor has replaced the acquired database under the same name with a different OID
- **THEN** recovery refuses and the replacement's sentinel survives

#### Scenario: Saved OID was renamed

- **WHEN** the exact saved name is absent but its OID exists under another name
- **THEN** recovery reports an identity mismatch without deleting either name or returning already-absent

### Requirement: Confirmed removal and idempotent absence

Recovery SHALL use ordinary DROP for the single validated target without FORCE, IF EXISTS, terminating sessions, changing roles or sweeping names. It SHALL return removed only after acknowledged DROP, confirmed catalog absence and successful close. It SHALL return already-absent only after full available validation and confirmed absence of both the original name and acquired OID, followed by successful close. It SHALL perform no setup, migration, data, schema or archive work.

#### Scenario: Explicit retry after removal

- **WHEN** a successful exact removal is followed by a fresh explicit recovery with the same valid record
- **THEN** the retry returns already-absent without creating a database or issuing DROP

#### Scenario: Another connection remains

- **WHEN** a peer is connected to the exact target
- **THEN** recovery fails without terminating that peer or reporting success
- **AND** a later explicit retry after peer closure can remove the target

### Requirement: Cooperative lifecycle exclusion with explicit limits

Normal setup, active ownership, clear and teardown SHALL retain a session advisory lock for the target on the base database from before CREATE until cleanup and final lease close. Recovery SHALL acquire the same target lock and retain it through verification and close. Lock contention, loss or unverifiable identity SHALL fail safely. The documentation SHALL require a stopped creator and exclusive disposable-target control and SHALL state that the lock does not prevent arbitrary outside DDL or make name-based DROP atomic by OID.

#### Scenario: Normal lifecycle is active

- **WHEN** recovery overlaps cooperating setup, active use, clear, partial cleanup, close or recreate for the same target
- **THEN** the lock prevents recovery from deleting that invocation's database
- **AND** existing setup promises, retry/reset behavior and both TypeORM owners retain their contracts

#### Scenario: Two recoveries overlap

- **WHEN** two fresh recoveries target the same acquisition concurrently
- **THEN** at most one performs DROP and contention is reported explicitly
- **AND** an explicit retry after the first closes can confirm already-absent

#### Scenario: A sibling is still running

- **WHEN** a different invocation holds a live database and sentinel during recovery
- **THEN** that invocation can keep using its database and its sentinel survives

#### Scenario: Lease or partial cleanup fails

- **WHEN** a lifecycle lease disconnects or teardown fails before or after DROP
- **THEN** normal state is retained for retry, incompatible setup/clear is refused, and any new administration session reacquires the lock and revalidates OID before DDL
- **AND** neither recovery nor reset silently forgets a failure

### Requirement: Bounded cancellation, uncertainty and safe errors

Recovery SHALL bound all work with timeoutMs and mandatory close with closeTimeoutMs, using the defaults and limits in the [archived design](../../changes/archive/2026-10-20-recover-retained-test-databases/design.md). It SHALL honor cancellation before destructive dispatch, stop further queries after failed validation and close every new session on all paths. Post-dispatch response loss or unconfirmed postconditions SHALL retain an unknown outcome. Every close failure SHALL reject, including after confirmed absence. Error messages and structured failure entries SHALL exclude names, OIDs, URLs, credentials and raw driver errors.

#### Scenario: Cancellation before DROP

- **WHEN** cancellation or deadline occurs before DROP permission, including during startup, connect or inspection
- **THEN** recovery closes within its cleanup budget, reports not-attempted, and cannot issue a late DROP

#### Scenario: DROP response or verification is uncertain

- **WHEN** cancellation, timeout, connection loss or failed verification follows DROP dispatch
- **THEN** recovery rejects with an unknown outcome and does not retry DDL automatically
- **AND** an explicit later retry may establish absence without erasing the prior failure

#### Scenario: Primary failure and close failure coexist

- **WHEN** work fails and the newly opened client also fails or times out during close
- **THEN** the error retains both ordered safe failure entries and exits without unhandled promises
- **AND** confirmed absence followed by close failure still rejects with the observed outcome retained

### Requirement: Owned administration transport and preserved TLS

The private administration helper SHALL create and retain its own Node socket and pass it through the public pg Client stream factory, with optional peer `pg: "^8.23.1"`. It SHALL preserve pg SSLRequest negotiation and configured certificate/hostname verification. It SHALL refuse unverified transport/negotiation settings without altering production configuration. It SHALL never retrieve driver-private transports, patch pg, send a dummy query to alter shutdown, unref as cleanup, or require caller process exit.

#### Scenario: Idle peer withholds shutdown

- **WHEN** a plaintext or established TLS peer withholds final shutdown beyond the graceful half of closeTimeoutMs
- **THEN** the helper records CLOSE_FAILED and destroys its retained owned socket within the same close budget
- **AND** it observes local close, public Client end and all started promise settlements, clears timers/listeners and exits naturally
- **AND** successful forced disposal cannot convert the graceful failure into success or erase an uncertain DROP outcome

#### Scenario: Connect or active work is interrupted

- **WHEN** abort/deadline interrupts connect, TLS negotiation, authentication or an active query
- **THEN** dispatch stops synchronously and the owned transport is disposed without waiting for graceful shutdown
- **AND** on natural session completion connect/query/end failures are observed, including the fixed local interruption error needed to settle unfinished connect
- **AND** no late readiness or queued continuation can issue another query, and natural exit needs no parent fixture cleanup

#### Scenario: Certificate validation fails

- **WHEN** a peer presents an untrusted certificate or a trusted certificate for the wrong DNS name or IP
- **THEN** pg rejects connection without disabling certificate verification or dispatching recovery work
- **AND** cleanup confirms child disposal within budget and the caller exits naturally, while valid trusted DNS/IP certificates remain usable

#### Scenario: Disposal cannot be confirmed or remote lock remains

- **WHEN** natural local closure or pending-operation settlement cannot be confirmed within the reserved close budget
- **THEN** recovery retains CLOSE_FAILED with any primary failure, disposes and joins its isolated child, and never reports success
- **AND** a locally closed lease is unusable, but retry must still acquire the server lock and cannot assume immediate remote lock release

### Requirement: Native public-package proof and consumable release

The change SHALL include mandatory native PostgreSQL CI coverage using real creator and fresh recovery processes, public compiled-subpath imports and declarations. It SHALL preserve normal setup/reset, migration and production/CLI regressions, document acquisition/recovery/compatibility, and release through the existing reviewed semantic-release workflow. Completion SHALL require verified actual publication, consumer-visible API/recipe and immutable PR/commit evidence.

#### Scenario: Public package is verified

- **WHEN** native CI runs on its owned PostgreSQL service
- **THEN** exact removal, retry, all refusal cases, lifecycle contention, deadlines/cancellation and natural recovery exits are exercised without skips
- **AND** injected transport/close failures are identified separately from native evidence, and fixtures are excluded from dist

#### Scenario: Release is pending or failed

- **WHEN** review has merged the feature but publication is pending or failed
- **THEN** the issue stays open with Founding Engineer responsible for release verification or repair routing
- **AND** no predicted version, manual publication, consumer installed-package patch or readiness claim substitutes for a verified consumable release

### Requirement: Recovery-only in-memory TLS and complete acquisition closure

Recovery SHALL accept the narrow TestDatabaseRecoveryTls PEM-string contract and mode matrix in the [archived design](../../changes/archive/2026-10-20-recover-retained-test-databases/design.md). It SHALL capture independent base/TLS inputs before awaits, preserve full certificate and DNS/IP identity verification, and perform no certificate-file acquisition or implicit driver URL parsing. It SHALL refuse file path parameters and conflicting/unsupported shapes before filesystem, Client or socket creation, using INVALID_INPUT and not-attempted. Existing normal setup/lifetime-lease TLS URL behavior SHALL remain supported.

#### Scenario: Certificate paths under real worker-pool contention

- **WHEN** a URL contains sslrootcert, sslcert or sslkey for an actual regular file or FIFO while finite unrelated work occupies the shared pool, with any sslmode or simultaneous PEM input
- **THEN** recovery refuses before every open/stat/read/close and every connect/query, without unfinished recovery-owned work
- **AND** deadline and cancellation variants settle within the declared work plus close allowance with no late dispatch and natural exit after fixture-owned work finishes

#### Scenario: Explicit TLS material is captured and verified

- **WHEN** valid trusted CA PEM and optional paired client certificate/key PEM are supplied independently with a supported mode
- **THEN** DNS/IP certificates and client identity work through pg SSLRequest with full peer verification
- **AND** unknown CA, wrong hostname/IP, malformed PEM, mismatched/partial client credentials, oversize strings, buffers/arrays and conflicting options fail safely under the stated validation/connection phase
- **AND** caller mutation after invocation cannot alter the captured trust or identity

#### Scenario: Normal TLS lifecycle compatibility

- **WHEN** normal forTest setup uses supported TLS certificate URL parameters
- **THEN** setup, lifetime exclusion and teardown retain their configuration contract without requiring the new recovery-only PEM preparation
- **AND** production forRoot configuration and migrations remain unchanged

#### Scenario: Internal authentication or resolution outlives socket close

- **WHEN** deadline/cancellation occurs while real hostname lookup or pg SCRAM crypto is queued behind finite unrelated shared-pool work in a cold fresh recovery process
- **THEN** recovery SHALL contain that work in its owned child and confirm child termination plus channel closure within the original work/close allowance, with no recovery work after return
- **AND** observed Client end/socket close alone cannot satisfy that requirement, unrelated fixture work is counted separately, and no abandoned promise or caller process exit substitutes for cleanup
- **AND** forced process disposal SHALL retain CLOSE_FAILED and never be described as fulfilled JavaScript work; a concrete unsupported disposal bound returns to Founding Engineer

### Requirement: Owned recovery child and conservative destructive permission

Recovery SHALL own one private packaged Node child, launched with process.execPath and no shell, inherited runtime flags, ambient PG/credential settings or descendants. The child SHALL own driver loading, DNS/TLS/authentication and the complete base-session/lease/DDL/verification lifecycle. Captured connection/PEM material SHALL travel only over bounded versioned owned IPC. The parent SHALL own the original work/close timeline and wait for observed process termination, closed IPC/stdio and all started send callbacks before returning. Ordinary callers SHALL exit naturally and existing normal lifecycle sessions SHALL retain their owner/configuration.

#### Scenario: Startup or IPC cannot progress

- **WHEN** startup/module loading, IPC backpressure, send failure, malformed/duplicate messages or child crash interrupts recovery
- **THEN** the original work/close allowance applies without another startup allowance, permission stops and the owned child is joined
- **AND** errors are fixed safe codes with no child diagnostics, secrets, target identity or connection material
- **AND** inability to launch refuses without in-process fallback; pre-abort launches no child

#### Scenario: Permission races with interruption or process death

- **WHEN** the child holds the lease, validates the exact target and requests DROP permission
- **THEN** the parent grants at most once while its deadline/signal permit, records unknown before send and the child rechecks stop/session/identity before SQL
- **AND** no grant means not-attempted; possible grant followed by cancellation/send failure/crash/result loss remains unknown unless trustworthy subsequent verification establishes absence
- **AND** no permit claims atomic SQL cancellation or atomic OID deletion

#### Scenario: Cleanup needs forced process disposal

- **WHEN** the owned child cannot finish naturally within the graceful half of the existing close budget
- **THEN** the parent records CLOSE_FAILED, terminates only its still-owned child and confirms exit plus closed channels before return
- **AND** forced disposal preserves any primary failure and uncertainty, never becomes success and is not described as natural child completion or fulfilled interrupted promises
- **AND** kill return values, killed flags, timers and result messages cannot substitute for disposal confirmation

#### Scenario: Parent channel disappears

- **WHEN** the child observes parent disconnect before readiness, during acquisition or after result/finish
- **THEN** it stops destructive work and interrupts its owned session even when terminal work is recorded
- **AND** its dedicated emergency self-SIGKILL timer remains armed until actual exit, capped by the existing absolute close ceiling and reserved disposal interval
- **AND** repeated disconnect/error/duplicate-terminal events can shorten that timer but cannot extend it
- **AND** no background recovery or descendant survives, and remote lock release or DROP absence is never inferred from local termination

#### Scenario: Terminal work retains emergency protection

- **WHEN** real queued DNS or SCRAM remains pending and the owned caller dies after result-before-finish, at finish or at disconnect
- **THEN** an independent owned supervisor observes child termination and IPC/stdio/fixture-peer closure within the original ceiling, without a fixture watchdog providing disposal or any late query
- **AND** result, finish, successful Client end and socket close do not remove the child's emergency fence or parent-loss/error handling
- **AND** intentional self-SIGKILL is disposal, not natural completion or fulfilled native promises

#### Scenario: Clean terminal work exits naturally

- **WHEN** no pending native work keeps a clean child alive after channel shutdown
- **THEN** the child exits naturally while retaining its emergency timer through shutdown
- **AND** only that dedicated timer may use Timeout.unref(); no process/channel/socket/parent-timer unref or beforeExit cancellation is allowed
- **AND** synchronous exit cleanup may clear the timer but is not external disposal proof

#### Scenario: Emergency disposal follows a terminal result

- **WHEN** a live parent observes forced child disposal after receiving a terminal result
- **THEN** it retains ordered primary failures followed by CLOSE_FAILED and joins exit/IPC/stdio and started sends before returning
- **AND** forced disposal cannot become clean success, and possible DROP permission remains unknown absent trustworthy subsequent verification

#### Scenario: Installed package and caller compatibility

- **WHEN** ordinary fresh CommonJS/ESM Node/Jest/Vitest callers invoke the installed public database subpath
- **THEN** the private compiled child entry is available independently of cwd/test loaders and every caller exits naturally after success or safe failure
- **AND** optional-pg imports, explicit empty passwords, captured TLS material and normal forRoot/forTest/setup/reset TLS behavior retain their stated contracts
