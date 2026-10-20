# Queued certificate acquisition blocks the recovery deadline

The current in-process file acquisition cannot meet the accepted recovery budget. Return this mismatch to the pipeline lead before implementation continues. No production workaround is applied.

Run from the built checkout with run scratch configured:

```sh
node openspec/changes/recover-retained-test-databases/verification/queued-tls-config-probe.cjs
```

The probe preloads modules and occupies four shared worker-pool threads with finite PBKDF2 work before calling the public recovery API with a real regular certificate file. It counts actual opens and database dispatches; no delayed filesystem implementation is injected. Its parent owns and removes the local fixture and bounds child cleanup.

Observed on implementation `09200481fe201c3b1b703eb4b8d6d7a0eee3d99e`, after a fresh build, with Node 24.13.0, pg 8.23.1 and @types/pg 8.23.1:

| Case         | Work + close budgets | Still pending at | Settled at | Abort at | Database dispatches | Natural exit |
| ------------ | -------------------- | ---------------- | ---------- | -------- | ------------------- | ------------ |
| Deadline     | 40 + 40 ms           | 151 ms           | 901 ms     | —        | 0                   | 0            |
| Cancellation | 40 + 40 ms           | 152 ms           | 848 ms     | 22 ms    | 0                   | 0            |

At each observation, one open had started and none had settled. Both eventually settle that open and return the expected safe error with outcome `not-attempted`. Event-loop timers run on time. These are file-acquisition failure observations, separate from native PostgreSQL evidence.

Node documents the shared worker pool and exposes no signal parameter for [open](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromisesopenpath-flags-mode), [FileHandle.stat](https://nodejs.org/docs/latest-v24.x/api/fs.html#filehandlestatoptions) or [FileHandle.close](https://nodejs.org/docs/latest-v24.x/api/fs.html#filehandleclose). It also states that aborting [readFile](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromisesreadfilepath-options) does not cancel individual operating-system requests. Nonblocking flags prevent the FIFO writer wait; they do not cancel queued acquisition or cleanup.

A promise race would leave file work running after return. Synchronous file calls would block deadline/cancellation processing during the call. Changing the global worker-pool size cannot establish an upper bound. None is a supported correction to this contract.

The lead must route an explicit design correction. One candidate is independently supplied, preloaded immutable TLS material with no file acquisition inside bounded recovery; that changes the public configuration contract and is not authorized by the current proposal. Preserve certificate/hostname verification, exact ownership, lifecycle exclusion, conservative outcomes and cleanup failures. Do not silently disable TLS, weaken budgets or require caller process exit.
