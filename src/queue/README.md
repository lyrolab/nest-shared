# Job Processing Module

Background job processing on BullMQ: decorator-registered job processors, named queues with isolated workers, cron scheduling, and optional OpenTelemetry-compatible telemetry.

## Dependencies

Requires the `SharedBullModule` (Redis-backed BullMQ connection) from `@lyrolab/nest-shared/bull`.

## Usage

1. Import the module:

```typescript
import { SharedBullModule } from "@lyrolab/nest-shared/bull"
import { SharedQueueModule } from "@lyrolab/nest-shared/queue"

@Module({
  imports: [SharedBullModule.forRoot(), SharedQueueModule.forRoot()],
})
export class AppModule {}
```

2. Create a job processor with the `@JobProcessor()` decorator:

```typescript
import { JobProcessor, JobProcessorInterface } from "@lyrolab/nest-shared/queue"

@Injectable()
@JobProcessor("my-job")
export class MyJobProcessor implements JobProcessorInterface {
  async process(job: Job) {
    // ...
  }
}
```

3. Enqueue jobs — no queue argument, routing is resolved from the processor's registration:

```typescript
await this.queueService.add("my-job", { userId: 1 })

await this.queueService.addBulk([
  { name: "my-job", data: { userId: 1 } },
  { name: "my-job", data: { userId: 2 }, opts: { delay: 1000 } },
])
```

## Named queues

Each named queue gets its own BullMQ queue and its own worker with its own concurrency, isolating lanes from each other (e.g. a bulk `sync` backlog never delays `notifications`):

```typescript
SharedQueueModule.forRoot({
  queues: [
    { name: "sync", concurrency: 50 },
    { name: "notifications", concurrency: 10 },
  ],
})
```

Bind a processor to a named queue via the decorator's `queue` field:

```typescript
@JobProcessor({ name: "send_push", queue: "notifications" })
```

Rules:

- Omitting `queue` registers the job on the default queue; omitting the `queues` option entirely gives a single default queue.
- Job names are globally unique: the same job name on two different queues fails at startup.
- Referencing a queue name not declared in `queues` fails at startup.
- The name `default` is reserved for the default queue; configure its worker with the module-level `concurrency` option.

With `forRootAsync`, `queues` stays a static property (queue registration cannot wait for an async factory):

```typescript
SharedQueueModule.forRootAsync({
  queues: [{ name: "sync", concurrency: 50 }],
  useFactory: (config: ConfigService) => ({
    concurrency: config.get("QUEUE_CONCURRENCY"),
  }),
  inject: [ConfigService],
})
```

## Cron jobs

```typescript
@JobProcessor({ name: "nightly-cleanup", cron: "0 0 * * *", queue: "sync" })
```

Schedulers are upserted on the job's queue at startup. Stale schedulers are cleaned up when a job's cron pattern changes or when the job moves to another queue; schedulers with names the module does not know are left untouched.

## Telemetry

Pass any implementation of BullMQ's native `Telemetry` interface (e.g. [`bullmq-otel`](https://www.npmjs.com/package/bullmq-otel)); it is threaded into every queue and worker the module creates, giving distributed traces with producer→consumer context propagation:

```typescript
import { BullMQOtel } from "bullmq-otel"

SharedQueueModule.forRoot({
  telemetry: new BullMQOtel("timecalendar"),
})
```

Metrics (counters, histograms) are not emitted by this module — consumers derive them from queue events.

## HTTP surface

`POST /queue/add` (`{ name, data? }`) enqueues a job through the same name-based routing.
