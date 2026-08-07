# Proposal — Named queues in `SharedQueueModule`

## Why

`SharedQueueModule` hardcodes a single `DEFAULT_QUEUE`, so all jobs share one BullMQ worker pool, concurrency setting, and backlog. TimeCalendar needs two isolated lanes — `sync` (bulk, up to 100k jobs per refresh cycle) and `notifications` (latency-sensitive pushes) — because a morning sync spike must not starve user-facing pushes. BullMQ's unit of isolation (worker pool, concurrency, rate limit) is the queue, so multi-queue support must land in this lib before the consuming server can be refactored.

## What Changes

- `SharedQueueModule.forRoot` / `forRootAsync` accept an optional `queues: [{ name, concurrency }]` option. Each named queue gets its own BullMQ queue registration and its own worker (processor instance) with its own concurrency.
- `@JobProcessor` metadata gains an optional `queue` field: `@JobProcessor({ name, cron?, queue? })`. Omitted `queue` routes to the default queue, exactly as today.
- `QueueService.add(name, data, opts?)` routes to the correct queue by resolving which queue the named job's processor is registered on — call sites keep the current shape, no queue argument.
- New `QueueService.addBulk(jobs)` for bulk enqueue (needed by the consumer's fan-out cron).
- Cron scheduling (`upsertJobScheduler` + stale-scheduler cleanup) works per queue: each job's scheduler lives on the queue its processor is registered on.
- Optional `telemetry` option (BullMQ ≥5.34 native telemetry interface, e.g. `BullMQOtel`) threaded into every Queue and Worker the module creates.
- Strictly additive: a no-option `forRoot()` behaves byte-for-byte as today (single `DEFAULT_QUEUE`, same decorator forms, same `QueueService` methods). Existing consumers upgrade with zero code changes — minor version bump, not major.

## Capabilities

### New Capabilities

- `multi-queue`: named queue registration, per-queue workers/concurrency, job-to-queue routing in `QueueService` (`add`/`addBulk`), per-queue cron scheduling, telemetry passthrough, and the backward-compatible single-queue default.

### Modified Capabilities

<!-- none — no existing specs in this repo -->

## Impact

- `src/queue/`: `shared-queue.module.ts`, `queue.constants.ts`, `interfaces/queue-options.interface.ts`, `decorators/queue.decorator.ts`, `processors/queue.processor.ts`, `services/queue.service.ts`, plus tests.
- `src/queue/README.md`, root `README.md` catalog if needed.
- Public API surface of `@lyrolab/nest-shared/queue` (additive only).
- Consumers: none forced to change; timecalendar server adopts named queues in a follow-up epic.
