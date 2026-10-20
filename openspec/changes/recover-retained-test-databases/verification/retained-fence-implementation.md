# Recovery disposal after caller loss

The dedicated child retains one emergency self-disposal timer through result, finish and IPC shutdown. The timer may be unreferenced so clean children exit naturally. Its absolute deadline can only shorten, and only synchronous process-exit cleanup clears it. Message validation and loss/error handlers remain active through shutdown. The parent still joins termination, channel closure and pending sends before returning.

## Public-boundary regression

`src/database/fixtures/isolation-scenarios.json` drives the existing generic runner. Twelve direct caller-death cases use the real caller → child process tree and the actual compiled private entry. There is no relay, copied production source or replacement recovery engine. Fixture wrappers observe public interfaces and queue actual DNS/SCRAM acquisition behind four finite fixture-owned PBKDF2 jobs. Those jobs are separate from recovery acquisition.

An independent fixture supervisor deliberately terminates only its owned caller before readiness, during acquisition, after result before parent delivery, on finish and after disconnect. Two finish cases inject repeated finish/error/disconnect events. The wrapper records only safe event counts/times in restricted scratch. After caller death, the supervisor observes the exact orphan's termination through Linux `/proc` (absent or terminated/zombie state), together with the child IPC-disconnect observation. A self-signal request alone cannot satisfy this assertion. Process termination closes its descriptors and disposes queued native work; it does not fulfill interrupted JavaScript promises or establish a remote database outcome. A watchdog disposes failed fixtures only and must remain unused for a passing case.

Ten queued-acquisition children intentionally self-SIGKILL; two before-readiness children exit without a self-signal. Every caller in this group is deliberately killed. They are not natural-caller-exit evidence. The terminal cases require no acquisition settlement or query and disposal within the initial retained half-close fence, allowing 40 ms for supervisor scheduling. Repeated events cannot extend that fence. The original work/close budgets remain 500/400 ms, with no extra cleanup allowance. Before-readiness cases delay only fixture entry loading to make the loss boundary observable.

Three live-caller controls deny the fixture parent's kill method, requiring the real child's emergency timer to provide disposal. Queued DNS/SCRAM retain DEADLINE_EXCEEDED then CLOSE_FAILED and not-attempted. A modeled already-absent result with finite native work added at result still rejects with CLOSE_FAILED and preserves already-absent. Their fixture watchdogs remain unused; callers exit naturally. SQL/session modeling is injected evidence, separate from native PostgreSQL acceptance.

## Commands and scope

Build first, then run:

```sh
node src/database/fixtures/isolation-runner.cjs --only caller-death
node src/database/fixtures/isolation-runner.cjs --only terminal-self
node src/database/fixtures/isolation-runner.cjs --only terminal-success
node src/database/fixtures/package-runner.cjs
```

On Linux / Node 24.13.0 / pg and installed/locked types 8.23.1, twelve direct caller-death and three terminal self-disposal cases pass. Terminal caller-loss disposal is 199–206 ms; during-acquisition disposal is 216–224 ms; before-readiness termination is 96–103 ms. Three single-CPU repetitions of both finish-race cases also pass (177–189 ms after caller death). All watchdogs remain unused. The seven packed-install cases pass with natural caller exits, compiled private entry present and fixtures excluded.

Implementation and regression source input: `acdea32674083c9a60ff3a6056dc9ede3bf64d07`. Affected verification passes 152/152 tests in three suites with no skips (510.035 seconds): 48 native PostgreSQL cases, 101 unit tests including the 81-case actual-child table and 30 helper/configuration cases, and three CLI cases. The owned PostgreSQL 16 container is removed. Build, full lint, formatting, declarations and strict OpenSpec pass. Database/manifests/compiler/workflow input SHA-256 is `213622169022ed93a74d88ce1135c1c355c31b94c3286f0ae20fdcadece2e5f6` (42 sorted filename/NUL/content/NUL-framed files). Both implementation-head CI checks pass; final metadata-head CI is recorded separately before handoff. The checkpoint preserves commands and invalidation conditions. Native SQL, native TLS forwarding and injected local protocol/session checks remain distinct. Historical failing-input probes and the scratch-only prerequisite remain scoped to their recorded commits.

Recheck after child/parent/protocol/session changes, runner/data/build/package changes, or runtime/platform/driver/pool/timer/process changes. Production configuration/migrations, auth/JWT/session, AI prompt/token and release workflow are outside this correction. After reviewed merge, return the open issue to Founding Engineer for actual release/npm/API/recipe verification.
