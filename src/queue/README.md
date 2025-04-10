# Job Processing Module

The job processing module provides a robust way to handle background jobs and queues using Bull and Redis.

## Dependencies

```bash
npm install @nestjs/bull bull
```

## Features

- Decorator-based job processor registration
- Automatic queue management
- Built-in test environment support with Redis TestContainers
- Type-safe job processing

## Usage

1. Import the queue module in your `app.module.ts`:

```typescript
import { SharedQueueModule } from "@lyrolab/nest-shared/queue"

@Module({
  imports: [SharedQueueModule],
})
export class AppModule {}
```

2. Create a job processor using the `@JobProcessor()` decorator:

```typescript
import { JobProcessor } from "@lyrolab/nest-shared/queue"

@Injectable()
@JobProcessor("my-job")
export class MyJobProcessor {
  async processJob(job: Job) {
    // Process your job here
  }
}
```

3. Enqueue a job:

```typescript
await this.queueService.addJob("my-job", {
  // Job data
})
```

## Environment Variables

- `REDIS_URL`: Required for production environment
- `NODE_ENV`: Set to 'test' for test environment configuration
