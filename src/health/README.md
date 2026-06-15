# Health Module — `@lyrolab/nest-shared/health`

Health check endpoint for your NestJS application using `@nestjs/terminus`.

## What Is This?

A simple module that registers a `GET /health` endpoint that:

- Pings the database connection (TypeORM) to verify it's alive
- Returns a 200 OK with health status when everything is fine
- Returns a 503 with error details when a dependency is down

## How Do I Use It?

```typescript
import { Module } from "@nestjs/common"
import { SharedHealthModule } from "@lyrolab/nest-shared/health"

@Module({
  imports: [SharedHealthModule],
})
export class AppModule {}
```

That's it. Your app will now respond at `GET /health`:

```json
// HTTP 200
{
  "status": "ok",
  "info": {
    "database": {
      "status": "up"
    }
  }
}

// HTTP 503
{
  "status": "error",
  "error": {
    "database": {
      "status": "down",
      "message": "Connection refused"
    }
  }
}
```

## Requirements

- Your application must have TypeORM configured (e.g., via `SharedDatabaseModule`) so the `TypeOrmHealthIndicator` can work.

## What It Registers

```typescript
TerminusModule.forRoot({ gracefulShutdownTimeoutMs: 1000 })
// with a HealthController at GET /health
```

## Notes

- The `/health` endpoint is automatically excluded from authentication by `JwtAuthGuard` (from the auth module), so you don't need to mark it `@Public()`.
- `gracefulShutdownTimeoutMs: 1000` means Terminus will allow 1 second for ongoing health checks to complete during shutdown.

## Related Modules

- [Database](../database/README.md) — required for the DB health check to work
- [Auth](../auth/README.md) — `JwtAuthGuard` auto-excludes `/health`
