# Tasks — Named queues

## 1. Options & metadata

- [x] 1.1 Add `QueueDefinition { name; concurrency? }` and `queues?: QueueDefinition[]` + `telemetry?: Telemetry` to `QueueModuleOptions`; add static `queues` to `QueueModuleAsyncOptions` (`interfaces/queue-options.interface.ts`)
- [x] 1.2 Extend `JobProcessorMetadata` with `queue?: string` (`decorators/queue.decorator.ts`)

## 2. Discovery & registry

- [x] 2.1 Extract shared job discovery into a registry helper/service: scan `@JobProcessor` providers, normalize string/object metadata, expose job-name → { processor, queue, cron } resolution
- [x] 2.2 Fail-fast validation on init: same job name on two different queues throws; `queue` referencing an unregistered queue name throws

## 3. Per-queue processors

- [x] 3.1 Refactor `QueueProcessor` into a base class parameterized by queue name; keep default-queue class byte-for-byte compatible (module-level `concurrency` via existing `SetMetadata` path)
- [x] 3.2 `createQueueProcessor(queueDef)` class factory applying `Processor({ name }, { concurrency, telemetry })` programmatically; one provider per named queue
- [x] 3.3 Dispatch guard: each worker only invokes processors whose metadata resolves to its own queue; `shouldProcessJob` overlap-skip checks its own queue only

## 4. Module wiring

- [x] 4.1 `forRoot`: `BullModule.registerQueue` per named queue (+ default) with `telemetry` in queue options; register per-queue processor providers
- [x] 4.2 `forRootAsync`: same static `queues` registration; queue-side telemetry via `BullModule.registerQueueAsync` with `inject: [QUEUE_MODULE_OPTIONS]`
- [x] 4.3 `QueueService`: inject all registered queues (map by `getQueueToken`), route `add` by job-name resolution with default-queue fallback

## 5. QueueService API

- [x] 5.1 `addBulk(jobs)`: resolve queue per job, group, one `queue.addBulk` per target queue, return flattened jobs
- [x] 5.2 Per-queue cron scheduling: each queue upserts only its own cron jobs; stale cleanup for pattern changes, moved-queue jobs, foreign schedulers untouched

## 6. Tests

- [x] 6.1 Regression suite: no-option `forRoot()` — default queue only, string-form decorator, `add` routes to default, module-level concurrency applied (spec: Backward-compatible default queue)
- [x] 6.2 Registration & wiring tests via `Test.createTestingModule`: per-queue processors and queue providers exist for `forRoot` and `forRootAsync` (spec: Named queue registration)
- [x] 6.3 Routing tests: `add` to declaring queue, unregistered name → default, `addBulk` mixed-queue grouping + returned jobs (specs: Job-name routing, Bulk enqueue)
- [x] 6.4 Dispatch tests: worker processes only its own queue's jobs; per-queue concurrency in worker options (spec: Processor-to-queue binding)
- [x] 6.5 Validation tests: cross-queue duplicate job name throws; unknown queue name throws (specs: Global job-name uniqueness, unknown-queue scenario)
- [x] 6.6 Cron tests: named-queue scheduling, pattern-change cleanup, moved-between-queues cleanup, foreign scheduler untouched (spec: Per-queue cron scheduling)
- [x] 6.7 Telemetry tests: instance reaches queue registration options and worker options; absent by default (spec: Telemetry passthrough)

## 7. Docs & release

- [x] 7.1 Update `src/queue/README.md`: `queues` option, `queue` metadata field, `addBulk`, telemetry example (`bullmq-otel`)
- [x] 7.2 Root `README.md` catalog line if wording mentions single queue
- [x] 7.3 Conventional `feat:` commit for a semantic-release minor bump
