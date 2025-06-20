# Nest Shared

A collection of shared modules for NestJS applications used across our company's projects. This package provides reusable components for common functionality including AI, Redis/Cache/Bull/Queue, and Database operations.

## Installation

```bash
npm install @lyrolab/nest-shared
```

## Features

- [Database Module](./src/database/README.md): Shared database configurations and utilities
- [AI Module](./src/ai/README.md): Common AI-related functionality
- [Job Processing Module](./src/queue/README.md): Shared queue management
- [Caching Module](./src/cache/README.md): Shared caching functionality

## Quick Start

1. Install the package:

```bash
npm install @lyrolab/nest-shared
```

2. Import the modules you need in your `app.module.ts`:

```typescript
import { SharedDatabaseModule } from "@lyrolab/nest-shared/database"
import { AiModule } from "@lyrolab/nest-shared/ai"
import { SharedQueueModule } from "@lyrolab/nest-shared/queue"
import { SharedCacheModule } from "@lyrolab/nest-shared/cache"

@Module({
  imports: [
    SharedDatabaseModule.forRoot(),
    AiModule,
    SharedQueueModule,
    SharedCacheModule.forRoot(),
  ],
})
export class AppModule {}
```

For detailed documentation and configuration options for each module, please refer to their respective README files.

## Standard Environment Variables

The following environment variables are commonly used across projects utilizing this package:

- `PORT`: Port on which the backend application will run.
- `FRONTEND_URL`: URL of the frontend application, used for CORS configuration.
- `DATABASE_URL`: Connection URL for the PostgreSQL database.
- `REDIS_URL`: Connection URL for the Redis database.
