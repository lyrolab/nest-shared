# Redis Module — `@lyrolab/nest-shared/redis`

Low-level Redis configuration module. Provides the `RedisConfig` class with the Redis connection URL and optional key prefix.

## What Is This?

A lightweight module that reads `REDIS_URL` from environment configuration and makes it available as an injectable `RedisConfig` instance. It supports production and test environments.

## How Do I Use It?

### Production

```typescript
import { Module } from "@nestjs/common"
import { SharedRedisModule, RedisConfig } from "@lyrolab/nest-shared/redis"

@Module({
  imports: [SharedRedisModule.forRoot()],
})
export class AppModule {}
```

### Test Environment

```typescript
import { Module } from "@nestjs/common"
import { SharedRedisModule, RedisConfig } from "@lyrolab/nest-shared/redis"

@Module({
  imports: [SharedRedisModule.forTest()],
})
export class AppTestModule {}
```

The `forTest()` method expects `REDIS_URL` to be set in the environment and will append a worker-specific prefix (`test_<poolId>`) to isolate test runs.

### Injecting RedisConfig

```typescript
import { Injectable } from "@nestjs/common"
import { RedisConfig } from "@lyrolab/nest-shared/redis"
import Redis from "ioredis"

@Injectable()
export class MyRedisService {
  private client: Redis

  constructor(config: RedisConfig) {
    this.client = new Redis(config.url)
  }

  async get(key: string) {
    return this.client.get(key)
  }
}
```

## RedisConfig

```typescript
export class RedisConfig {
  constructor(
    public readonly url: string,       // e.g., "redis://localhost:6379"
    public readonly keyPrefix?: string, // e.g., "test_1"
  ) {}
}
```

## ⚠️ Important: When to Use This vs. SharedCacheModule

**For caching, prefer `SharedCacheModule.forRoot()` from `@lyrolab/nest-shared/cache`** which provides a `Cache` instance (via `@nestjs/cache-manager`) backed by Redis with built-in TTL support.

Use `SharedRedisModule` when you need **lower-level Redis access** via `ioredis` directly (e.g., pub/sub, Redis streams, Lua scripts, or operations not supported by `cache-manager`).

| Use Case | Recommended Module |
|----------|-------------------|
| Key-value caching with TTL | `SharedCacheModule` (inject `Cache`) |
| Redis pub/sub, streams, Lua scripts | `SharedRedisModule` (use `ioredis` directly) |
| Custom Redis data structures | `SharedRedisModule` (use `ioredis` directly) |

## Environment Variables

| Variable | Required | Description |
|----------|:--------:|-------------|
| `REDIS_URL` | ✅ | Redis connection string (e.g., `redis://localhost:6379`) |

## How Other Modules Use This

This module is a dependency for:

- **`SharedCacheModule`** — uses `RedisConfig.url` to configure `@keyv/redis`
- **`SharedBullModule`** — uses `RedisConfig.url` for BullMQ connection
- **`SharedQueueModule`** — uses `RedisConfig.url` for job queue processing

## Related Modules

- [Cache](../cache/README.md) — higher-level Redis-backed caching (preferred for most use cases)
- [Bull](../bull/README.md) — BullMQ queue integration using this module
- [Queue](../queue/README.md) — job processing using this module
