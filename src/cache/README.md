# Caching Module

The caching module provides a unified caching solution using Redis as the storage backend.

## Dependencies

```bash
npm install @nestjs/cache-manager @keyv/redis
```

## Features

- Redis-based caching
- Automatic test environment configuration
- Configurable TTL (Time To Live)
- Global cache instance

## Usage

1. Import the cache module in your `app.module.ts`:

```typescript
import { SharedCacheModule } from "@lyrolab/nest-shared/cache"

@Module({
  imports: [SharedCacheModule.forRoot()],
})
export class AppModule {}
```

2. Use the cache in your services:

```typescript
import { CACHE_MANAGER } from "@nestjs/cache-manager"
import { Inject, Injectable } from "@nestjs/common"
import { Cache } from "cache-manager"

@Injectable()
export class MyService {
  constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {}

  async getData(key: string) {
    const cachedData = await this.cacheManager.get(key)
    if (cachedData) {
      return cachedData
    }

    // Fetch and cache data
    const data = await this.fetchData()
    await this.cacheManager.set(key, data)
    return data
  }
}
```

## Configuration

The cache module supports the following configuration:

### Test Environment (`NODE_ENV=test`)

- Creates a Redis container using TestContainers
- Automatically configures test Redis instance

### Production Environment

- Uses REDIS_URL from ConfigService
- Configurable TTL via CACHE_TTL environment variable

## Environment Variables

- `REDIS_URL`: Required for production environment
- `CACHE_TTL`: Cache time-to-live in seconds
- `NODE_ENV`: Set to 'test' for test environment configuration
