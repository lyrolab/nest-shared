# Parent loss after finish

The child must keep its emergency disposal path after a terminal result. The current
finish handler clears the fence and its disconnect handler ignores a finished child.
Actual queued DNS and SCRAM work can therefore survive parent death past the close
ceiling. Recovery remains blocked on this finding.

## Reproduce

From the built checkout, with the run-owned scratch directory configured:

```sh
npm run build
node openspec/changes/recover-retained-test-databases/verification/finish-parent-loss-probe.cjs dns
node openspec/changes/recover-retained-test-databases/verification/finish-parent-loss-probe.cjs scram
node openspec/changes/recover-retained-test-databases/verification/ref-fence-control.cjs
```

The first runner preserves the reviewer's public-package reproducer and selects DNS
or SCRAM. It adapts the existing generic actual-child fixture in restricted scratch,
loads the real compiled private entry, and queues real acquisition behind four finite
fixture PBKDF2 calls. It terminates only its owned caller after the child's finish and
IPC disconnect. A fixture-owned one-second self-SIGKILL watchdog bounds the defective
child observation. No PostgreSQL or destructive query is involved. Intentional signals
are not natural exits; fixture jobs are separate from the unresolved acquisition.

On Linux / Node 24.13.0 / pg and installed/locked types 8.23.1, fresh build of
`9b9be7cf95403fc1f2d9d22397a0d0de2191e4f0` passes. Both durable cases confirm the defect:

| Acquisition | Result after acquisition | Finish | Disconnect | Still alive after disconnect |
| ----------- | -----------------------: | -----: | ---------: | ---------------------------: |
| DNS         |                   370 ms | 373 ms |     374 ms |                     1,003 ms |
| SCRAM       |                   339 ms | 340 ms |     340 ms |                     1,001 ms |

Each result is DEADLINE_EXCEEDED/connect/not-attempted. At the late observation one
acquisition has started, none has settled, and zero queries have dispatched. Both owned
callers terminate by the intended SIGKILL. The original reviewer input also reproduces
SCRAM survival for 1,002 ms after disconnect. Work is 500 ms and close is 400 ms.

These are failure observations, not passing public-boundary acceptance. Prior green CI
and native/package evidence do not establish the missing parent-loss guarantee.

## Historical design constraint

The selected isolation direction forbids unref, detached cleanup, descendants, private
pg access and caller exit requirements. It also requires natural clean-child completion.
The Applier must return a concrete mismatch rather than silently redesigning it.

An unconditional referenced self-SIGKILL timer through disconnect protects pending
acquisition, but also keeps an otherwise clean child alive until it kills that child.
The separate Node control has no database or pending native work: without a fence it
exits naturally code 0; with a referenced 100 ms self-fence it dies by SIGKILL at 108 ms.
Its beforeExit observer has not fired, so beforeExit cannot clear that referenced fence
to recover natural completion. This control proves the behavior of a referenced timer;
it is not a production replacement or a proof that every possible design is impossible.

Node documents [referenced timers](https://nodejs.org/api/timers.html#timeoutref) and
[beforeExit](https://nodejs.org/docs/latest-v24.x/api/process.html#event-beforeexit).
Clearing the timer on result/finish reproduces the defect. Socket close and Client end
cannot certify the hidden DNS/SCRAM work, as the queued-connection report establishes.
The existing negative process.exit control also rules out synchronous exit as disposal.

The selected correction is specified in design decision 1d and [its prerequisite proof](retained-fence.md). The statements below describe the constraint at the failing input, not current authorization. One narrow candidate
is to permit only the dedicated child's emergency timer to be unreferenced, retain it
through finish/disconnect, and clear it on actual process exit. Pending native work keeps
the child alive for the self-SIGKILL fence; a clean child can exit naturally. This candidate
requires explicit correction of the no-unref direction and actual public-child proof;
it is not implemented or approved by this report. Parent-side observed termination and
closed channels must remain mandatory; unref alone never establishes disposal. Another
supported boundary may be selected instead.

After selection, implement on the same issue/branch/PR. Add real parent-death cases after
result and finish for both queued acquisitions, check the entire close ceiling, retain
natural clean-child/caller exits, permission uncertainty and ordered CLOSE_FAILED, and
rerun affected native/package checks and final-head CI. No production or release change
is included in this evidence-only checkpoint.

Exact durable probe inputs:

- `finish-parent-loss-probe.cjs` SHA-256: `f7053f7fd67b4bcee46f4884ba178686a432b38876d9bd3d4bb1105ab30d0df6`.
- `ref-fence-control.cjs` SHA-256: `1a627f25ca43989717ec232b26d179268525e94bbfdb56569b52d031390d70ad`.
