# Bull Module — `@lyrolab/nest-shared/bull`

BullMQ queue integration backed by Redis. Registers BullMQ with your application's Redis connection for background job processing.

## What Is This?

A dynamic module that configures [BullMQ](https://docs.bullmq.io/) for NestJS via `@nestjs/bullmq`. It:

- Reads Redis connection details from `SharedRedisModule` (which reads `REDIS_URL` from env)
- Registers BullMQ's `forRootAsync()` with the shared Redis config
- Supports optional `keyPrefix` from `RedisConfig` for namespacing

## How Do I Use It?

### 1. Register the Module

```typescript
import { Module } from "@nestjs/common"
import { SharedBullModule } from "@lyrolab/nest-shared/bull"

@Module({
  imports: [SharedBullModule.forRoot()],
})
export class AppModule {}
```

### 2. Create a Queue and Processor

```typescript
import { Processor, WorkerHost } from "@nestjs/bullmq"
import { Job } from "bullmq"

@Processor("my-queue")
export class MyProcessor extends WorkerHost {
  async process(job: Job): Promise<void> {
    // Process the job
    console.log(`Processing job ${job.id}:`, job.data)
  }
}
```

### 3. Add Jobs to the Queue

```typescript
import { Injectable } from "@nestjs/common"
import { InjectQueue } from "@nestjs/bullmq"
import { Queue } from "bullmq"

@Injectable()
export class MyService {
  constructor(@InjectQueue("my-queue") private queue: Queue) {}

  async addTask(data: any) {
    await this.queue.add("task", data, {
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
    })
  }
}
```

## What It Configures

`SharedBullModule.forRoot()` registers the global BullMQ connection:

```typescript
BullModule.forRootAsync({
  inject: [RedisConfig],
  useFactory: (redisConfig: RedisConfig) => ({
    connection: { url: redisConfig.url },
    ...(redisConfig.keyPrefix && { prefix: redisConfig.keyPrefix }),
  }),
})
```

This means you can then use `BullModule.registerQueue()` in your feature modules normally.

## Environment Variables

| Variable | Required | Description |
|----------|:--------:|-------------|
| `REDIS_URL` | ✅ | Redis connection string |

## Related Modules

- [Redis](../redis/README.md) — provides the `RedisConfig` that Bull depends on
- [Cache](../cache/README.md) — alternative Redis-backed module for caching
- [Queue](../queue/README.md) — higher-level job processing with decorator-based processors (uses Bull under the hood)
