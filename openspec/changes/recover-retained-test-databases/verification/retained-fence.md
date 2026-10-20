# Retain emergency disposal through child exit

The child keeps one self-disposal timer through result, finish and channel shutdown. Only this dedicated timer may use Timeout.unref(). A clean child can exit naturally; native DNS/SCRAM work keeps a stuck child alive until its self-SIGKILL fence. The parent still confirms termination and closed channels. Timer liveness never proves disposal.

## Run the prerequisite

From the checkout with built output and a configured run-owned scratch directory:

```sh
npm run build
node openspec/changes/recover-retained-test-databases/verification/retained-fence-probe.cjs
```

The runner copies dist into restricted scratch and changes only the copied private entry's fence behavior. It retains the packaged public API, real compiled engine/session and real pg acquisition. No production source, driver, dependency or package is changed. The copied entry retains terminal message validation, arms a non-extending timer before result, keeps disconnect/error handling active, and synchronously clears the timer on exit. Only that timer is unreferenced.

For actual caller-death observations, an independent fixture supervisor owns the private entry and relays its versioned IPC to an ordinary caller invoking the built public API. The caller's spawn is intercepted with a fixture event proxy; its production supervision code still runs. This topology lets the supervisor retain the exact ChildProcess handle and observe exit, IPC disconnect, stdout/stderr closure and send callbacks after intentionally killing only its owned caller. It disconnects the entry's owning channel when the caller dies. This is a protocol/ownership prerequisite fixture, not a claim that the production parent spawns via a relay. Applier must port the cases to direct packaged public-boundary regressions.

The entry queues one actual DNS lookup or SCRAM derivation behind four finite fixture-owned PBKDF2 jobs. No delayed acquisition is injected. A local supervisor-owned protocol peer supplies SCRAM negotiation; no PostgreSQL or SQL deletion is involved. Fixture crypto is separate from recovery acquisition. The supervisor asserts no permission, query, acquisition settlement or API return after caller loss. Terminated native work is disposed, not fulfilled. SCRAM peers close before fixture cleanup. A 2.5-second fixture watchdog exists only for failed-run cleanup and must remain unused.

The supervisor kills its owned caller before readiness, at readiness before start, during acquisition, after result before forwarding it, upon finish receipt, or after terminal disconnect. Repeated-error cases inject a duplicate finish, an error and another disconnect during the retained fence. Scratch-only synchronous audit records prove fence deadlines never increase and stay within the parent's received close ceiling. The supervisor joins independent public events; aggregate ChildProcess close is not required because explicit parent disconnect can suppress it on this runtime.

The second group reuses the existing generic table-driven runner against the scratch entry without the IPC relay. It covers modeled removal/absence, connect/close failure, pre/post-permission cancellation and permission-send failure, before-readiness cancellation, real queued DNS/SCRAM deadline and channel loss. Two terminal-self acquisition cases disable parent killing with an unused owned watchdog: the child must self-dispose after a terminal result while the live public caller preserves DEADLINE_EXCEEDED then CLOSE_FAILED and not-attempted. Each ordinary caller must exit naturally. A further terminal-success control queues finite native fixture work after modeled absence; forced self-disposal must retain CLOSE_FAILED with the verified already-absent outcome. Modeled SQL/session outcomes are injected, not native database proof.

## Result and limits

Pass: 29/29 cases on Linux / Node 24.13.0 / pg 8.23.1. Fourteen supervisor cases include four natural pre-start child exits and ten intentional child self-SIGKILL disposals. Every owned caller-death fixture ends by deliberate SIGKILL. Fifteen generic-runner controls have natural caller exits; eight have natural internal child exits, seven have intentional SIGKILL disposal. Every fixture watchdog stays unused. Repeated-event cases each exercise at least four fence evaluations without extending the first deadline.

| Acquisition | Loss boundary | Repeated events | Confirmed disposal after loss |
| ----------- | ------------- | --------------- | ----------------------------: |
| dns         | pre-ready     | no              |                        132 ms |
| dns         | ready         | no              |                         10 ms |
| dns         | work          | no              |                        213 ms |
| dns         | result        | no              |                        204 ms |
| dns         | finish        | no              |                        205 ms |
| dns         | disconnect    | no              |                        206 ms |
| scram       | pre-ready     | no              |                        134 ms |
| scram       | ready         | no              |                          8 ms |
| scram       | work          | no              |                        209 ms |
| scram       | result        | no              |                        205 ms |
| scram       | finish        | no              |                        203 ms |
| scram       | disconnect    | no              |                        204 ms |
| dns         | finish        | yes             |                        204 ms |
| scram       | finish        | yes             |                        204 ms |

Terminal result/finish/disconnect cases confirm termination with remaining time before the original received close ceiling. Acquisition starts once and never settles or sends a query before disposal. Work is 500 ms and close is 400 ms; no extra allowance is added. Natural remove/absence and safe connect/close failure controls retain existing table budgets. The two acquisition terminal-self cases preserve ordered primary plus CLOSE_FAILED for the still-live public caller. Forced disposal after modeled successful absence rejects with CLOSE_FAILED and retains already-absent. These measurements apply to this local runtime, without a real-time OS guarantee.

Exact SHA-256 inputs:

- `src/database/internal/test-database-recovery-child.ts`: `35ef85fd7b05977f57f173284115e0511147d826ae5914288348f6c23b975332`.
- `dist/database/internal/test-database-recovery-child.js`: `4795c02bf1916c0d39296b38ded0ddefda17e662de3855cca2a95bedcc4b8dbe`.
- `src/database/internal/test-database-recovery-parent.ts`: `7fa5f91fe6afa0775f5fab23d1dea8dcc3666f97deed7e5a01cef709ba0c3048`.
- `src/database/fixtures/isolation-runner.cjs`: `5bf45e00bfb6f6248991405a40c09a21a5a27baf2af8f57efb287f9c0a1b77cf`.
- `src/database/fixtures/isolation-scenarios.json`: `c01473ac79030fc68a319df9b6afb31dd1cee217bef7c26a8a70cd2e4f046b3d`.
- `src/database/fixtures/recovery-fault-scenarios.json`: `2d2bb8d1cd6d3ad362fd767607e017eea0b2e66f3154c7977e5b2213306f30a8`.
- `openspec/changes/recover-retained-test-databases/verification/retained-fence-probe.cjs`: `99a4d3ae8d7be49e4cf6afe53b60148300d05e919116d72cf6ec5f79f22baf22`.

The historical [finish parent-loss failure](finish-parent-loss.md), [referenced-timer control](ref-fence-control.cjs) and queued file/DNS/SCRAM reports remain failing-input evidence for their recorded commits. This prerequisite does not complete implementation tasks or replace native/public-package, clean build/install or final-head CI checks. Production configuration/migrations, auth/JWT/session, prompt/token and release workflow remain unchanged.

Recheck when the child/parent/protocol/session, generic runner/scenarios, probe, compiler output, runtime/OS, pg/dependencies, pool or timer/process semantics change. Applier must verify the actual correction, natural caller/child success and failure, ordered CLOSE_FAILED even after terminal success, conservative permission uncertainty, direct parent death, affected native ownership/lifecycle/two-process cases, packed callers and final-head CI. Reviewer returns the open issue to Founding Engineer after reviewed merge for release/API/version verification.
