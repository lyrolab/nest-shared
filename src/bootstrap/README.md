# Bootstrap Module — `@lyrolab/nest-shared/bootstrap`

A single function call that configures common NestJS application middleware, filters, and Swagger setup.

## What Is This?

The `configureApp()` function takes a `NestExpressApplication` instance and applies:

- **CORS** — configured with `FRONTEND_URL` from `ConfigService`, with `credentials: true`
- **Global ValidationPipe** — with `forbidNonWhitelisted: true` and `whitelist: true` to strip unknown request properties
- **Global Exception Filter** — `TypeOrmExceptionFilter` for consistent TypeORM error responses
- **Shutdown Hooks** — enables graceful shutdown
- **Swagger/OpenAPI** — sets up Swagger at the `/api` path with version `1.0`

## How Do I Use It?

```typescript
// main.ts
import { NestFactory } from "@nestjs/core"
import { configureApp } from "@lyrolab/nest-shared/bootstrap"
import { AppModule } from "./app.module"

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule)
  configureApp(app)
  await app.listen(process.env.PORT ?? 3000)
}
bootstrap()
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|:--------:|---------|-------------|
| `FRONTEND_URL` | ✅ | — | Allowed origin for CORS |
| `PORT` | ❌ | `3000` | Application listen port |

## What `configureApp` Does (in detail)

```typescript
// Equivalent to calling configureApp(app):
app.useGlobalPipes(
  new ValidationPipe({ forbidNonWhitelisted: true, whitelist: true }),
)
app.useGlobalFilters(new TypeOrmExceptionFilter())
app.enableCors({
  origin: configService.get("FRONTEND_URL"),
  credentials: true,
})
app.enableShutdownHooks()

// Swagger
const config = new DocumentBuilder().setVersion("1.0").build()
const documentFactory = () => SwaggerModule.createDocument(app, config)
SwaggerModule.setup("api", app, documentFactory)
```

## Related Modules

- [Auth](../auth/README.md) — global `JwtAuthGuard` is applied separately via `SharedAuthModule`
- [Database](../database/README.md) — provides the `TypeOrmExceptionFilter` used by `configureApp`
