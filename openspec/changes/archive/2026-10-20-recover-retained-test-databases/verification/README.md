# Verification

The [retained emergency fence proof](retained-fence.md) specifies the selected child-only timer exception and its exact prerequisite scope. Production still requires the correction in design decision 1d and tasks 3.3, 7.1 and 8.1; earlier green checks exclude the parent-loss-after-finish race.

# Administration transport prerequisite

The administration helper owns a Node socket supplied through pg's public Client
stream factory. It can dispose that socket when a peer stalls, while pg retains
responsibility for TLS negotiation and certificate checks. The transport proof
passes with pg 8.23.1 and Node 24.13.0. This is injected transport evidence,
not native PostgreSQL recovery acceptance or complete acquisition closure.
Recovery uses preloaded PEM material and one packaged Node child under design
decisions 1a–1d. The [DNS/SCRAM acquisition audit](queued-connection.md) records why
socket disposal alone cannot settle all connection work. Implemented public-child,
TLS and native evidence and remaining checks are recorded in the checkpoint.

## Run

Use locked repository dependencies, Node and OpenSSL. Set
`PAPERCLIP_RUN_SCRATCH_DIR` or `PAPERCLIP_SCRATCH_DIR` to a writable run-owned scratch
directory. The owned-stream runner creates short-lived self-signed fixture
certificates there and removes them in finally. It needs no database, external
service, credentials or installed consumer package.

```sh
node openspec/changes/recover-retained-test-databases/verification/pg-close-probe.cjs
node openspec/changes/recover-retained-test-databases/verification/owned-stream-probe.cjs
node --check openspec/changes/recover-retained-test-databases/verification/owned-stream-probe.cjs
```

`transport-scenarios.json` supplies the cases to one runner. Each case gets its own
ordinary Node child and parent-owned loopback fixture. The child retains its own
`net.Socket`, supplies `stream: () => ownedSocket`, and uses only public Client
connect/query/end/error/end interfaces and Node socket APIs. It never reads back
the driver's socket, patches pg, sends a dummy query, calls unref/process.exit, or
runs detached cleanup. The IPC channel synchronizes the stalled phase and is
explicitly disconnected after transport disposal; the parent then observes
natural child exit before closing any fixture peer.

The fixture speaks only enough PostgreSQL protocol for startup, AuthenticationOk,
ReadyForQuery and query observation. TLS cases use a real Node TLS server after
SSLRequest, with certificate validation enabled in the real pg client. Its peers
keep their writable side open during graceful shutdown. Active cases withhold the
query response. Interrupted startup cases schedule late readiness; the parent
counts query packets and fails on any unexpected dispatch. No DROP is sent.

The close budget is 1,000 ms: 500 ms for graceful close and 500 ms reserved for
forced disposal/confirmation. Interruption is triggered 100 ms after the fixture
confirms its phase, with pg's own 4,000 ms connection/query timeout deliberately
longer. Each case requires owned-socket close, public Client end and settlement of
all connect/query/end promises before report, no unhandled rejection, empty child
stderr and natural exit code 0 before fixture cleanup. Expected connection/query
failures are asserted inside the probe, so code 0 means that proof passed.
Certificates, keys, ports and raw failure details are never printed. Each child
has a 6-second parent watchdog that fails the probe before killing only that child;
fixture cleanup is bounded separately. Certificate generation has a 10-second
subprocess limit. These watchdogs never establish a passing shutdown result.

## Observed results

Both commands above passed on 2026-10-20 with locked pg 8.23.1 and Node 24.13.0.
The original `pg-close-probe.cjs` remains a control: active-query end settles within
100 ms and exits naturally; idle end and repeated end both exceed 100 ms and the
child stays alive through another 200 ms observation window. Only that negative
control needs parent peer cleanup before exit. This isolates the unsupported
assumption that idle `client.end()` alone bounds disposal.

The owned-stream proof passes all 13 cases:

| Scenario                                  | Close observed | Forced fallback / CLOSE_FAILED | Natural exit before fixture cleanup |
| ----------------------------------------- | -------------- | ------------------------------ | ----------------------------------- |
| Plaintext idle stall                      | 503 ms         | Yes / yes                      | Yes                                 |
| Plaintext active query stall              | 2 ms           | No / no                        | Yes                                 |
| Plaintext connect/auth interruption       | 3 ms           | No / no                        | Yes                                 |
| Stalled TLS negotiation interruption      | 5 ms           | No / no                        | Yes                                 |
| Established TLS connect/auth interruption | 8 ms           | No / no                        | Yes                                 |
| Established TLS idle stall                | 505 ms         | Yes / yes                      | Yes                                 |
| Established TLS active query stall        | 3 ms           | No / no                        | Yes                                 |
| Untrusted TLS certificate                 | 2 ms           | No / no                        | Yes                                 |
| Trusted certificate for wrong DNS name    | 3 ms           | No / no                        | Yes                                 |
| Trusted certificate for wrong IP          | 2 ms           | No / no                        | Yes                                 |
| Plaintext active query interruption       | 4 ms           | No / no                        | Yes                                 |
| Established TLS active query interruption | 6 ms           | No / no                        | Yes                                 |
| Trusted TLS IP, idle stall                | 504 ms         | Yes / yes                      | Yes                                 |

All 13 children exit with code 0, with all started operations settled and zero
unhandled rejections. Only the four active cases send one SELECT each; every
other case sends zero queries. The fixture confirms a completed TLS handshake for
all established TLS cases. Untrusted certificates and trusted DNS/IP mismatches
reject with the expected Node TLS error classifications. Both trusted localhost
and trusted IP certificates connect successfully.

In the TLS idle cases, the retained raw socket is destroyed after the graceful
interval; the probe then observes public Client end, local socket close, pending
promise settlement and natural child exit while the server fixture remains open.
This proves disposal through pg's TLS wrapping for the tested implementation;
it does not infer closure from the raw socket's `destroyed` flag. Active and
handshake interruptions also destroy the retained socket immediately and settle
naturally. A fixed local error on interrupted connect ensures its promise rejects;
silent destruction combined with Client's ending state can leave it pending.
Error observers remain installed through disposal.

The probe's `closeFailed` flag retains the missed graceful deadline even when
forced disposal succeeds. It is a transport observation, not an implemented
TestDatabaseRecoveryError. Applier must verify ordered primary/CLOSE_FAILED errors,
conservative DROP outcomes and public cancellation through the implemented API.

## Supported boundary and implementation work

Use optional peer `pg: "^8.23.1"`. The public factory predates this floor, but
8.23.1 is the verified implementation for factory ownership, TLS wrapping and
DNS/IP checks. Later compatible 8.x upgrades must keep these regressions passing;
no lower version is claimed. Support Node TCP and pg's default PostgreSQL
SSLRequest negotiation for this administration path. Direct TLS negotiation,
custom caller streams, Unix sockets and alternate runtimes need separate proof
before this API accepts them. Preserve production connection configuration.

Public references: [stream-factory changelog](https://github.com/brianc/node-postgres/blob/pg%408.23.1/CHANGELOG.md),
[8.23.1 connection implementation](https://github.com/brianc/node-postgres/blob/pg%408.23.1/packages/pg/lib/connection.js),
[pg TLS options](https://node-postgres.com/features/ssl), and
[Node socket.destroy](https://nodejs.org/docs/latest-v24.x/api/net.html#socketdestroyerror).

Port these cases into the private helper/API regression runner before relying on
them for production code. Explicit URL/base/role binding, parsed TLS settings,
monotonic cancellation, lifecycle lease loss, deadlines and safe combined errors
still need implementation verification. No native database, role, recovery API,
package declaration or release is proved here. A local close also does not prove
immediate remote advisory-lock release during a partition; retries must acquire
the server lock normally. No task, ownership safeguard or release gate is waived.

Evidence is invalidated by changes to the probe/data, pg lock/version, Node/TLS
runtime or supported transport/negotiation. Re-run after those changes and verify
the actual implementation separately. The following SHA-256 inputs identify this
run (formatting changes require a fresh run):

```text
59f1ee6387d5dda4d0bb1fc9ee1c4c6de61b500cc814ce78c9d9bb9547206f30  owned-stream-probe.cjs
7956618c6b89eb90e6895f0dc463c739b5317498658a6271aba33369f4b0504d  transport-scenarios.json
4b8ed77e196eb925c2910ed2ae2045943ee356e85ab83206770c08ccac9e6aae  pg-close-probe.cjs
```

## Verification required for the configuration correction

Keep the queued certificate and connection probes as historical failure inputs. The selected one-child boundary and prerequisite evidence are in [isolated-connection.md](isolated-connection.md); port the selected PEM/mode matrix into the generic public runner. Use actual finite worker-pool saturation with actual regular/FIFO paths and require refusal before every open/stat/read/close and network dispatch. Prove valid trusted DNS/IP and paired client certificate/key PEM, safe refusal of unknown trust/hostname/malformed/conflicting input, captured caller values and normal TLS lifetime-lease compatibility.

Audit cold initialization, resolution, credential fallback, authentication and TLS together. Require every natural session operation to settle or be disposed by confirmed termination of its isolated child within the original work/close allowance, no post-return work and natural caller exits. Report intentional child signals separately. Count unrelated fixture-owned pool jobs separately. Re-run clean locked install/build, affected public/transport/native checks and final-head CI for the implemented correction; earlier green checks do not establish these guarantees.

The isolation design keeps one parent work/close timeline, explicit permission before DROP and observed exit/IPC/stdio closure before return. The dedicated child uses self-SIGKILL on parent loss if native work cannot settle; process.exit is not a sufficient emergency fence on the measured finite-crypto input. Normal lifecycle sessions retain their existing owner and TLS URL behavior.
