# Design — Named queues

## Context

`src/queue/` today: `SharedQueueModule.forRoot`/`forRootAsync` register exactly one BullMQ queue (`DEFAULT_QUEUE = "default"`), one `QueueProcessor` (`WorkerHost` bound via `@Processor(DEFAULT_QUEUE)`), and one `QueueService` that injects that single queue. Job handlers are discovered via the `@JobProcessor` decorator (`string | { name, cron? }`) using `DiscoveryService`. Cron jobs are scheduled on module init via `upsertJobScheduler` with stale-pattern cleanup. Concurrency is a single module-level option applied through a `SetMetadata("bullmq:worker_metadata", …)` write in the processor constructor.

Constraints:

- Strictly additive — a no-option `forRoot()` must behave byte-for-byte as today. Minor version bump.
- BullMQ requires one worker (one `WorkerHost`) per queue; `@Processor` binds a class to a queue name statically.
- `BullModule.registerQueue` runs at module-definition time, so queue names must be known synchronously — including in `forRootAsync`.
- `bullmq` dependency is `^5.46.1`, above the ≥5.34 floor for the native `telemetry` option.

## Goals / Non-Goals

**Goals:**

- Multiple named queues, each with its own worker and concurrency.
- Job-name→queue routing inside `QueueService` so call sites never pass a queue name.
- `addBulk` for bulk enqueue.
- Per-queue cron scheduling with stale cleanup (pattern changes and jobs moved between queues).
- Optional BullMQ-native telemetry threaded into every Queue and Worker.

**Non-Goals:**

- Priority lanes, rate limiters, per-queue admin UI.
- Per-queue Redis connections (all queues share `SharedBullModule`'s connection).
- Migrating consumer apps.

## Decisions

### D1 — `queues` is a static option, in both `forRoot` and `forRootAsync`

`QueueDefinition = { name: string; concurrency?: number }`. `forRoot({ queues })` and `forRootAsync({ queues, ...asyncOptions })` take the list as a plain (non-factory) value because `BullModule.registerQueue(...)` must run synchronously when the dynamic module is built. The async factory keeps supplying the existing `QueueModuleOptions` (default-queue `concurrency`, and now `telemetry`). Alternative — allowing the factory to return `queues` — was rejected: queue registration cannot wait for DI.

### D2 — One processor class per queue via a class factory

A factory `createQueueProcessor(queueDef)` returns a distinct subclass of the shared processor logic with `Processor({ name }, { concurrency })` applied programmatically, registered as a provider per named queue. Discovery/scheduling/dispatch logic stays in one base class; only the queue binding and worker options differ. The default queue keeps the existing `QueueProcessor` class and its `SetMetadata` concurrency path untouched (regression safety). Alternative — one worker multiplexing several queues — is impossible in BullMQ.

### D3 — Routing by decorator metadata, resolved at call time from discovery

`@JobProcessor` metadata gains `queue?: string`. `QueueService` receives a map of queue name → `Queue` instance (injected via `getQueueToken(name)` for every registered queue) and resolves a job name to its queue by scanning discovered `@JobProcessor` providers (same `DiscoveryService` pattern the processor already uses). Unknown job names (e.g. ad-hoc `QueueController` adds) fall back to the default queue — today's behavior. Alternative — an eagerly built static map — adds init-ordering risk for no gain; scan result may be memoized after first resolution.

### D4 — Job-name uniqueness is global; cross-queue duplicates fail fast

Two processors sharing a job name on _different_ queues would make `add(name, …)` ambiguous. On module init, the module SHALL throw listing the offending job name(s). Same-name duplicates within one queue keep today's (first-wins) behavior to avoid a breaking change.

### D5 — Per-queue cron scheduling and stale cleanup

Each queue's processor schedules only the cron jobs whose metadata resolves to its queue. Cleanup on init, per queue:

1. Remove schedulers on this queue whose `name` matches a registered job but whose `pattern` differs (existing behavior, now per queue).
2. Remove schedulers on this queue whose `name` matches a job registered on a _different_ queue (job moved between queues). Schedulers with names unknown to the module are left untouched — they may belong to the consumer.

### D6 — Telemetry as a passthrough option

`QueueModuleOptions.telemetry?: Telemetry` (BullMQ's own interface, e.g. `bullmq-otel`'s `BullMQOtel`). Threaded into every `BullModule.registerQueue` call (queue side) and into worker options for every processor (worker side). The lib does not depend on any OTel package — the consumer constructs and passes the instance. In `forRootAsync`, queue-side telemetry uses `BullModule.registerQueueAsync` with `inject: [QUEUE_MODULE_OPTIONS]` so the factory-resolved value reaches queue construction. Metrics (counters/histograms) are explicitly the consumer's job, from queue events.

### D7 — `addBulk` groups by resolved queue

`addBulk(jobs: { name; data; opts? }[])` resolves each job's queue, groups, calls `queue.addBulk` per group, returns the flattened `Job[]`. One BullMQ round-trip per queue rather than per job — the point of the API for 100k-job fan-outs.

### D8 — Tests stay at the unit level with mocked `Queue` instances

The existing suite (`queue.processor.spec.ts`) mocks `DiscoveryService` and `Queue`; the new suite follows suit — no Redis in CI. Nest `Test.createTestingModule` covers provider wiring (per-queue processors, routing map); mocked queues cover routing, bulk grouping, scheduling, cleanup, and telemetry threading. The no-option regression path gets its own dedicated tests.

## Risks / Trade-offs

- [Cross-queue stale-scheduler cleanup deletes a scheduler the consumer created with a colliding name] → cleanup only touches names the module knows from `@JobProcessor` scan; documented in README.
- [`shouldProcessJob` overlap-skip uses `queue.getActive()` — on the sync queue with high concurrency this scan gets more expensive] → unchanged semantics per queue, only cron (repeat) jobs pay it; noted for epic 02 tuning.
- [Programmatic `Processor()` application relies on decorator being callable as a function] → standard NestJS decorator factory; covered by a wiring test so a `@nestjs/bullmq` upgrade regression is caught.
- [Telemetry option only proven against the BullMQ interface, not a real OTel pipeline] → out of lib scope; consumer verifies traces end-to-end (epic 02).

## Migration Plan

Additive minor release. Existing consumers upgrade with zero code changes; `queues`/`telemetry` are opt-in. No rollback concerns beyond reverting the version.
