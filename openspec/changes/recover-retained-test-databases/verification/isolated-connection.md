# Owned-process recovery prerequisite

The supported isolation candidate disposes queued DNS and SCRAM work before the supervising caller returns. The design keeps the complete recovery session in one owned Node child, with explicit parent permission before destructive SQL. This report verifies public Node/pg interfaces with local fixtures. It does not implement or prove the revised recovery API, its full wire schema, native ownership checks or package publication.

## Run

```sh
node openspec/changes/recover-retained-test-databases/verification/isolated-connection-probe.cjs
node openspec/changes/recover-retained-test-databases/verification/owned-stream-probe.cjs
```

Set PAPERCLIP_RUN_SCRATCH_DIR or PAPERCLIP_SCRATCH_DIR to an owned scratch directory for these engineering probes only. Product callers use neither variable. The runner creates short-lived local certificates there and removes them; no certificate/key, URL, target name/OID or raw diagnostic is printed. Optional positional case selection runs one named data row. Every case lives in isolation-scenarios.json; one runner handles them all.

Observed on Linux, Node 24.13.0, pg 8.23.1: **32/32 expected observations pass**, supervising command exit 0. This count includes a negative process.exit control and a pre-abort/no-launch case. The remaining 30 child cases include 20 natural code-0 completions, five parent-SIGKILL disposals, two self-SIGKILL disposals after parent loss, two intentional code-7 crashes and one missing-entry code-1 failure. Intentional exits/signals are not natural completion or fulfilled interrupted JavaScript promises.

The acquisition cases use 200 ms work and 300 ms total close. Cold startup uses 1 ms work; the other protocol/TLS cases use 1,000 ms work and 300 ms close so ordinary module/TLS startup has time to reach the phase under test. All positive cases assert the whole timeline against work+close (with a stated 50 ms scheduling tolerance), and interruption cases separately check close from interruption. These observations do not prove every possible caller-selected budget or provide a real-time OS guarantee. They preserve the original defaults/limits; a concrete unsupported disposal bound is returned to Founding Engineer.

## What is exercised

- Real four-worker contention uses four finite PBKDF2 jobs, with no delayed DNS/crypto implementation. Public dns.lookup and WebCrypto deriveBits are wrapped only to count/notify starts and completions. DNS/SCRAM start but remain unfulfilled at disposal; peers observe zero queries and no SCRAM socket survives the child's confirmed termination. Killing the child disposes its entire native work context; it does not fulfill those promises. Unrelated parent-owned pool jobs are awaited separately after the invocation measurement. Child-owned fixture jobs are deliberately destroyed with the isolated process.
- Parent work timers start before spawn; remaining time includes cold entry/module loading, IPC and connection. A readiness notification cannot restart the clock. Pre-abort does not launch, cancellation before ready sends no initialization, and a missing entry fails before a session. The parent-pool case completes while the supervisor's finite pool work remains separately owned.
- All captured connection/PEM values travel over IPC; the child environment is empty, argv contains only the entry/case selector, and execArgv is empty. The case selector is fixture control, never secret material. The mutation case copies primitive material before the first await, mutates caller fields before launch and also mutates the send object after serialization; the child still verifies the captured trust.
- PostgreSQL SSLRequest fixtures prove trusted DNS and IP peers, client certificate/key presentation with signature verification against fixture trust, unknown CA/wrong DNS/wrong IP refusal, stalled negotiation, and plaintext/TLS idle/active interruption. The fixture checks the client certificate through public X509Certificate.verify; this is local mutual-TLS material/transport evidence, not native PostgreSQL client-auth configuration. The unchanged owned-stream runner separately passes **13/13** graceful/fallback/abort transport cases, including all started Client operations and natural child exits before fixture cleanup.
- Protocol fixtures simulate permission and terminal observations without issuing DROP. They exercise no permission after interruption, unknown recorded before permission send, a crash before/after permission, duplicate/malformed messages, and a verified observation followed by clean disposal. Actual catalog ownership, DDL acknowledgement and absence proof remain implementation/native acceptance work. Only active transport cases send SELECT 1; no fixture performs a destructive SQL command.
- A child deliberately refuses to read IPC; a 3 MiB private synthetic start body produces actual send backpressure. Deadline forces only that owned child and every started send callback is observed. Other cases close the actual channel and attempt a send, or crash. No secret/diagnostic is echoed from the child; the missing-entry case drains and discards Node's diagnostic stream.
- Parent loss during actual queued DNS/SCRAM triggers the private child's local self-SIGKILL fence. The supervisor never sends SIGKILL in those two cases. It observes termination and each channel/pipe closure before cleanup/return. No background work survives.

## Two interface details the implementation must preserve

The finite-PBKDF2 negative control calls process.exit after its timer fires. It takes **1,061 ms from that fence to observed exit**, 1,169 ms total. A self-exit call is therefore insufficient for the private child's emergency fence on this input. Use supported self-SIGKILL only inside the dedicated entry. The owned-process boundary permits disposing that exact internal child; it never authorizes caller, saved creator or PostgreSQL peer termination.

An explicit parent IPC disconnect yields exit, disconnect and both stdio-close events, but **no aggregate ChildProcess close event** on this tested Node input. The runner joins the individual public events, with observers installed before any send/disconnect. The normal signal/completion cases also observe the aggregate event. Production ignore stdio has no parent pipe to join. Do not replace event confirmation with connected/killed/destroyed flags or wait only on an aggregate event that this input does not emit.

The parent-loss self fence completes in 216/220 ms total for DNS/SCRAM. Parent deadline/cancel acquisition disposal takes 365/306/363/324 ms total; the parent-signal to disposal observations are 8–15 ms. All six acquisition cases have zero permission and queries, not-attempted, observed termination and closed channels. Parent forced fallback and child self fallback retain CLOSE_FAILED with the primary failure. Local process disposal cannot prove remote lock release or a DROP outcome.

## Observations

| Case                            | Elapsed ms | Exit      | Disposal / observation                |
| ------------------------------- | ---------: | --------- | ------------------------------------- |
| process-exit-workerpool-control |       1169 | 1         | negative process.exit control         |
| pre-abort                       |          — | no launch | not-attempted                         |
| dns-deadline                    |        365 | SIGKILL   | parent SIGKILL; CLOSE_FAILED retained |
| dns-cancel                      |        306 | SIGKILL   | parent SIGKILL; CLOSE_FAILED retained |
| scram-deadline                  |        363 | SIGKILL   | parent SIGKILL; CLOSE_FAILED retained |
| scram-cancel                    |        324 | SIGKILL   | parent SIGKILL; CLOSE_FAILED retained |
| dns-parent-disconnect           |        216 | SIGKILL   | self-SIGKILL after parent loss        |
| scram-parent-disconnect         |        220 | SIGKILL   | self-SIGKILL after parent loss        |
| cold-start-deadline             |         83 | 0         | not-attempted                         |
| cancel-before-ready             |         75 | 0         | not-attempted                         |
| missing-private-entry           |         70 | 1         | not-attempted                         |
| parent-pool-contention          |        161 | 0         | unknown                               |
| plaintext-idle                  |        127 | 0         | not-attempted                         |
| plaintext-active                |       1014 | 0         | not-attempted                         |
| tls-idle-dns                    |        184 | 0         | not-attempted                         |
| tls-active-ip                   |       1018 | 0         | not-attempted                         |
| tls-negotiation-stall           |       1014 | 0         | not-attempted                         |
| tls-mutual                      |        160 | 0         | unknown                               |
| tls-unknown-ca                  |        168 | 0         | not-attempted                         |
| tls-wrong-dns                   |        176 | 0         | not-attempted                         |
| tls-wrong-ip                    |        167 | 0         | not-attempted                         |
| tls-caller-mutation             |        176 | 0         | unknown                               |
| ipc-backpressure                |       1156 | SIGKILL   | parent SIGKILL; CLOSE_FAILED retained |
| ipc-disconnect                  |        144 | 0         | not-attempted                         |
| ipc-send-failure                |        152 | 0         | not-attempted                         |
| child-crash-before-permit       |         84 | 7         | not-attempted                         |
| child-crash-after-permit        |        140 | 7         | unknown                               |
| abort-at-permit-request         |        144 | 0         | not-attempted                         |
| abort-after-permit              |        134 | 0         | unknown                               |
| duplicate-permit-request        |        135 | 0         | unknown                               |
| malformed-message               |         81 | 0         | not-attempted                         |
| verified-result-natural         |        134 | 0         | removed                               |

## Evidence scope and next owner

The probe uses public ChildProcess, Node socket/TLS/X509 and pg Client interfaces. It owns and removes every local fixture. The supervising process exits naturally after fixture cleanup; forced internal children are reported as such. It does not load the changed production API, enforce every final IPC field/count/phase rule, prove native DDL or test installed packaging. The protocol candidate's harmless verified message is not PostgreSQL absence evidence.

Applier implements decisions 1a–1d and ports cases to the built public-package boundary. Replace parent-side pg mocks that would no longer run. Verify regular/FIFO TLS-path refusal before file/client/socket operations under actual contention, the full mode/PEM matrix, malformed material and client pairing, optional-pg/empty password behavior, packaged CJS/ESM/Jest/Vitest callers, normal TLS lease setup/teardown, native ownership/lifecycle/two-process recovery, clean locked install/build and final-head CI. Preserve all original identity/OID/owner and exclusive-target safeguards.

The queued-tls-config and queued-connection reports remain historical failing inputs. Prior successful native/398-test baseline evidence retains only its exact recorded code/runtime scope. No full-suite, new native recovery, revised public-API success, release or consumer readiness is claimed here.

Inputs are unchanged production implementation at 9a35f29283b27f4c55e3a95b5f0200d893f83357 (source/build/native digest f58f2e90ba0e6f633654b3be245b568033fd9f4ca7967feb782113ef08f1435d); this correction changes only OpenSpec documents and prerequisite probe/data. Exact probe/data hashes:

```text
054f0c0ed291af87b872eeaabd598aae70fed11cbca03cd2479f2fe09055ec01  isolated-connection-probe.cjs
6adeaedce9fd95a05813160161e95c7a9937aed12c4ba10bf33fa82b645eccad  isolation-scenarios.json

```

Rerun when probe/data, runtime/OS, pg/lock, TLS/crypto, protocol/disposal, pool or transport inputs change. Implementation changes need their own public-boundary/native evidence. Do not treat this probe as proof for untested platforms, minimum budgets, process sandboxes or package contents.

Primary references: [Node child-process interfaces](https://r2.nodejs.org/docs/latest-v24.x/api/child_process.html), [Node process.kill](https://nodejs.org/docs/latest-v24.x/api/process.html#processkillpid-signal), [pg SSL](https://node-postgres.com/features/ssl). The no-aggregate-close and process.exit timings above are measured observations, not claims drawn from those documents.
