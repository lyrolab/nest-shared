# Nest Shared

A collection of shared NestJS modules published to npm as `@lyrolab/nest-shared`. Provides reusable infrastructure components for NestJS applications across LyroLab projects.

## Installation

```bash
npm install @lyrolab/nest-shared
```

> **Note:** `@lyrolab/nest-shared` declares many peer dependencies. You'll need to install the ones you actually use. See each module's README for its specific peer dependency requirements.

## Module Catalog

| Module | Import Path | Description | Key Exports | Requires Config |
|--------|-------------|-------------|-------------|:--------------:|
| [AI](./src/ai/README.md) | `@lyrolab/nest-shared/ai` | OpenRouter AI service with response caching | `SharedAiModule`, `AiService`, `AI_MODULE_OPTIONS` | ✅ |
| [Auth](./src/auth/README.md) | `@lyrolab/nest-shared/auth` | JWT/Keycloak authentication | `SharedAuthModule`, `JwtAuthGuard`, `@Public()`, `@CurrentUser()`, `keycloakConfig()` | ✅ |
| [Bootstrap](./src/bootstrap/README.md) | `@lyrolab/nest-shared/bootstrap` | Application setup (CORS, ValidationPipe, Swagger, filters) | `configureApp()` | ✅ |
| [Bull](./src/bull/README.md) | `@lyrolab/nest-shared/bull` | BullMQ queue integration backed by Redis | `SharedBullModule` | ✅ |
| [Cache](./src/cache/README.md) | `@lyrolab/nest-shared/cache` | Redis-backed caching (preferred over raw Redis) | `SharedCacheModule` | ✅ |
| [Database](./src/database/README.md) | `@lyrolab/nest-shared/database` | TypeORM + PostgreSQL connection with TestContainers | `SharedDatabaseModule`, `TypeOrmExceptionFilter` | ✅ |
| [ESLint](./src/eslint/README.md) | `@lyrolab/nest-shared/eslint` | Shared ESLint config with custom architecture rules | `nestArchitecturePlugin` | ❌ |
| [Health](./src/health/README.md) | `@lyrolab/nest-shared/health` | Health check endpoint via Terminus | `SharedHealthModule` | ❌ |
| [Queue](./src/queue/README.md) | `@lyrolab/nest-shared/queue` | Job processing with decorator-based processors | `SharedQueueModule`, `QueueService`, `@JobProcessor()` | ✅ |
| [Redis](./src/redis/README.md) | `@lyrolab/nest-shared/redis` | Low-level Redis configuration | `SharedRedisModule`, `RedisConfig` | ✅ |

## Quick Start

```typescript
// app.module.ts
import { Module } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { SharedAuthModule } from "@lyrolab/nest-shared/auth"
import { SharedBootstrapModule } from "@lyrolab/nest-shared/bootstrap"
import { SharedCacheModule } from "@lyrolab/nest-shared/cache"
import { SharedDatabaseModule } from "@lyrolab/nest-shared/database"
import { SharedHealthModule } from "@lyrolab/nest-shared/health"
import { keycloakConfig } from "@lyrolab/nest-shared/auth"

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    SharedDatabaseModule.forRoot({
      entities: [__dirname + "/**/*.entity{.ts,.js}"],
    }),
    SharedAuthModule.forRoot(
      keycloakConfig(
        process.env.KEYCLOAK_URL ?? "http://localhost:8080",
        process.env.KEYCLOAK_REALM ?? "lyrochat",
      ),
    ),
    SharedCacheModule.forRoot(),
    SharedHealthModule,
  ],
})
export class AppModule {}
```

```typescript
// main.ts
import { NestFactory } from "@nestjs/core"
import { configureApp } from "@lyrolab/nest-shared/bootstrap"
import { AppModule } from "./app.module"

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  configureApp(app) // Sets up CORS, ValidationPipe, Swagger, global filters
  await app.listen(process.env.PORT ?? 3000)
}
bootstrap()
```

### Using Modules in Services

```typescript
import { Injectable } from "@nestjs/common"
import { Inject } from "@nestjs/common"
import { CACHE_MANAGER } from "@nestjs/cache-manager"
import { Cache } from "cache-manager"
import { AiService } from "@lyrolab/nest-shared/ai"
import { QueueService } from "@lyrolab/nest-shared/queue"
import { generateText } from "ai"

@Injectable()
export class MyService {
  constructor(
    private readonly aiService: AiService,
    private readonly queueService: QueueService,
    @Inject(CACHE_MANAGER) private cache: Cache,
  ) {}

  async process(input: string) {
    const cached = await this.cache.get(`input:${input}`)
    if (cached) return cached

    const result = await generateText({
      model: this.aiService.model,
      system: "You are a helpful assistant.",
      prompt: input,
    })

    await this.cache.set(`input:${input}`, result.text)
    return result.text
  }
}
```

## Environment Variables

| Variable | Required | Used By | Description |
|----------|:--------:|---------|-------------|
| `DATABASE_URL` | ✅ | Database | PostgreSQL connection string |
| `REDIS_URL` | ✅ | Redis, Cache, Bull, Queue | Redis connection string |
| `FRONTEND_URL` | ✅ | Bootstrap | Frontend origin for CORS |
| `JWKS_URI` | ✅ | Auth | JWKS endpoint for JWT verification |
| `JWT_ISSUER` | ✅ | Auth | JWT issuer to validate against |
| `PORT` | ❌ | Bootstrap | App listen port (default: 3000) |
| `CACHE_TTL` | ❌ | Cache | Cache TTL in seconds |
| `OPENROUTER_API_KEY` | ✅ | AI | OpenRouter API key |
| `NODE_ENV` | ❌ | All | Set to `test` for TestContainers mode |

## Development

### Local Setup

```bash
# Clone and install
git clone https://github.com/lyrolab/nest-shared.git
cd nest-shared
npm install

# Build
npm run build

# Run tests
npm test
npm run test:cov   # With coverage

# Watch mode
npm run dev
```

### Adding a New Module

1. Create `src/<module>/` with `index.ts` barrel export.
2. Write a `README.md` in the module directory.
3. Add the export entry in `package.json`:

```json
"./<module>": {
  "types": "./dist/<module>/index.d.ts",
  "import": "./dist/<module>/index.js",
  "require": "./dist/<module>/index.js"
}
```

4. Add a row to the **Module Catalog** table in this README.

### Code Quality

```bash
npm run lint        # ESLint
npx lint-staged     # Pre-commit checks
npm test            # Jest
```

## Publishing

This package uses **semantic-release** for automated publishing on the `main` branch.

- `feat:` commits → minor version bump
- `fix:` commits → patch version bump
- `feat!:` or `fix!:` commits → major version bump

See [CLAUDE.md](./CLAUDE.md) for detailed contribution conventions.
