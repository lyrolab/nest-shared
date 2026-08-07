# multi-queue

## Requirements

### Requirement: Named queue registration

`SharedQueueModule.forRoot` and `forRootAsync` SHALL accept an optional `queues` array of `{ name: string; concurrency?: number }`. For each entry the module SHALL register a dedicated BullMQ queue and a dedicated worker (processor) bound to that queue, with the entry's `concurrency` applied to that worker only.

#### Scenario: Two named queues get isolated workers

- **WHEN** the module is configured with `queues: [{ name: "sync", concurrency: 50 }, { name: "notifications", concurrency: 10 }]`
- **THEN** a BullMQ queue and a worker exist for each of `sync` and `notifications`, and each worker carries its own concurrency (50 and 10)

#### Scenario: Named queues via forRootAsync

- **WHEN** the module is configured through `forRootAsync` with the same static `queues` list
- **THEN** the same per-queue registrations and workers are created

### Requirement: Backward-compatible default queue

When the `queues` option is absent, the module SHALL behave exactly as the current single-queue module: one `default` queue, one worker honoring the module-level `concurrency` option, string and object `@JobProcessor` forms, and unchanged `QueueService.add`.

#### Scenario: No-option forRoot regression

- **WHEN** `SharedQueueModule.forRoot()` is called with no options
- **THEN** only the `default` queue is registered, jobs added via `QueueService.add` land on it, and processors declared with `@JobProcessor("job-name")` process them

#### Scenario: Named queues coexist with the default queue

- **WHEN** `queues` is provided and a processor omits the `queue` field in its metadata
- **THEN** that processor's jobs are registered and processed on the `default` queue

### Requirement: Processor-to-queue binding via decorator

`@JobProcessor` object metadata SHALL accept an optional `queue` field (`{ name, cron?, queue? }`). A processor with `queue` set SHALL have its jobs processed by that queue's worker; the worker of one queue SHALL NOT process jobs registered to another queue.

#### Scenario: Job processed on its declared queue

- **WHEN** a processor is declared with `@JobProcessor({ name: "send_push", queue: "notifications" })` and a `send_push` job runs on the `notifications` queue
- **THEN** the `notifications` worker invokes that processor's `process` method

#### Scenario: Unknown queue name fails fast

- **WHEN** a processor declares `queue: "typo"` and no queue with that name is registered
- **THEN** module initialization throws an error naming the job and the unknown queue

### Requirement: Job-name routing in QueueService

`QueueService.add(name, data, opts?)` SHALL enqueue the job on the queue where the named job's processor is registered, without any queue argument at the call site. Job names with no registered processor SHALL route to the default queue.

#### Scenario: add routes to the declaring queue

- **WHEN** `send_push` is registered on the `notifications` queue and `QueueService.add("send_push", data)` is called
- **THEN** the job is added to the `notifications` queue with the given data and options

#### Scenario: Unregistered job name falls back to default

- **WHEN** `QueueService.add("ad-hoc-job", data)` is called and no processor declares `ad-hoc-job`
- **THEN** the job is added to the `default` queue

### Requirement: Bulk enqueue

`QueueService` SHALL expose `addBulk(jobs: Array<{ name; data; opts? }>)` that routes each job by the same job-name resolution, issues one BullMQ `addBulk` call per target queue, and returns all created jobs.

#### Scenario: Mixed-queue bulk add

- **WHEN** `addBulk` receives jobs whose names resolve to two different queues
- **THEN** each queue receives exactly one `addBulk` call containing only its own jobs, and the returned array contains every created job

### Requirement: Global job-name uniqueness

Job-name resolution SHALL stay global. If two processors register the same job name on different queues, module initialization SHALL throw an error listing the conflicting job name.

#### Scenario: Cross-queue duplicate job name

- **WHEN** two processors both declare job name `refresh` with different `queue` values
- **THEN** module initialization throws an error naming `refresh`

### Requirement: Per-queue cron scheduling

Cron jobs (`@JobProcessor({ name, cron, queue? })`) SHALL be scheduled via `upsertJobScheduler` on the queue their processor is registered on. On init, each queue SHALL remove its own stale schedulers: those whose job name is registered on this queue but whose cron pattern changed, and those whose job name is now registered on a different queue. Schedulers whose names are unknown to the module SHALL be left untouched.

#### Scenario: Cron on a named queue

- **WHEN** a processor declares `@JobProcessor({ name: "drain", cron: "*/5 * * * *", queue: "notifications" })`
- **THEN** a job scheduler for `drain` with that pattern is upserted on the `notifications` queue and none is created on other queues

#### Scenario: Pattern change cleanup

- **WHEN** the `notifications` queue holds a `drain` scheduler with an old pattern and the decorator now declares a new pattern
- **THEN** the old scheduler is removed and the new pattern is upserted

#### Scenario: Job moved between queues

- **WHEN** `drain` was previously scheduled on the `default` queue and its processor now declares `queue: "notifications"`
- **THEN** the `default` queue's stale `drain` scheduler is removed and the scheduler exists on `notifications`

#### Scenario: Foreign schedulers untouched

- **WHEN** a queue holds a scheduler whose name matches no `@JobProcessor` in the application
- **THEN** cleanup does not remove it

### Requirement: Telemetry passthrough

The module SHALL accept an optional `telemetry` object implementing BullMQ's native `Telemetry` interface and SHALL pass it into the construction options of every queue and every worker it creates, in both `forRoot` and `forRootAsync`. When absent, no telemetry option is set.

#### Scenario: Telemetry reaches queues and workers

- **WHEN** the module is configured with a `telemetry` instance and two named queues
- **THEN** both queue registrations and both workers receive that instance in their options

#### Scenario: No telemetry by default

- **WHEN** the module is configured without `telemetry`
- **THEN** queues and workers are constructed without a telemetry option
