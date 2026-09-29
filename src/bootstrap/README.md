# Bootstrap Module — `@lyrolab/nest-shared/bootstrap`

Application setup helpers: `configureApp()` applies the common middleware, filters and Swagger UI, and `generateOpenApi()` writes the OpenAPI document to disk for client generation.

## What Is This?

The `configureApp()` function takes a `NestExpressApplication` instance and applies:

- **Global ValidationPipe** — with `forbidNonWhitelisted: true` and `whitelist: true` to reject unknown request properties
- **Global Exception Filter** — `TypeOrmExceptionFilter` for consistent TypeORM error responses
- **CORS** — origins from `CORS_ORIGINS` (comma-separated), falling back to `FRONTEND_URL`, with `credentials: true`
- **Shutdown Hooks** — enables graceful shutdown
- **Swagger UI** — served at `/api` (JSON at `/api-json`)

## How Do I Use It?

```typescript
// main.ts
import { NestFactory } from "@nestjs/core"
import { NestExpressApplication } from "@nestjs/platform-express"
import { configureApp } from "@lyrolab/nest-shared/bootstrap"
import { AppModule } from "./app.module"

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule)
  configureApp(app)
  await app.listen(process.env.PORT ?? 3000)
}
void bootstrap()
```

### Options

Every option is optional; `configureApp(app)` uses the defaults.

```typescript
configureApp(app, {
  // true (default) | false | CorsOptions merged over the defaults
  cors: { credentials: false },
  // true (default) | false | document options + `path`
  swagger: {
    path: "api",
    title: "BoardBot API",
    description: "BoardBot API",
    bearerAuth: true,
  },
  // merged over { whitelist: true, forbidNonWhitelisted: true }
  validationPipe: {
    transform: true,
    transformOptions: { enableImplicitConversion: false },
  },
})
```

| Option           | Type                             | Default | Description                                                                                   |
| ---------------- | -------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `cors`           | `boolean \| CorsOptions`         | `true`  | `false` skips CORS; an object is merged over the origin/credentials defaults                  |
| `swagger`        | `boolean \| SwaggerSetupOptions` | `true`  | `false` skips Swagger UI; an object sets `path` and the [document options](#document-options) |
| `validationPipe` | `ValidationPipeOptions`          | —       | Merged over the whitelist defaults                                                            |

### CORS Origins

`CORS_ORIGINS` accepts a comma-separated list; whitespace and empty entries are ignored. When it is unset or empty, `FRONTEND_URL` is used. `parseCorsOrigins(raw)` is exported for apps that need the same parsing elsewhere.

```bash
CORS_ORIGINS="https://app.example.com, https://admin.example.com"
```

## Generating the OpenAPI Document

`generateOpenApi(AppModule, options)` boots the module graph in Nest preview mode (controllers are scanned, providers are never instantiated, so no database, Redis or API key is needed), builds the document and writes it as pretty-printed JSON.

```typescript
// src/generate-openapi.ts
import { generateOpenApi } from "@lyrolab/nest-shared/bootstrap"
import { AppModule } from "./app.module"

generateOpenApi(AppModule, { title: "BoardBot API", bearerAuth: true })
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Failed to generate OpenAPI specification", error)
    process.exit(1)
  })
```

Env validation in `ConfigModule.forRoot` still runs in preview mode, so set placeholder values for required variables before importing `AppModule` when generating in CI.

| Option       | Type      | Default              | Description                                     |
| ------------ | --------- | -------------------- | ----------------------------------------------- |
| `outputPath` | `string`  | `<cwd>/openapi.json` | Where the JSON file is written                  |
| `preview`    | `boolean` | `true`               | `false` boots the full application instead      |
| …            |           |                      | Plus every [document option](#document-options) |

### Document Options

Shared by `generateOpenApi`, the `swagger` option of `configureApp`, `buildSwaggerConfig` and `createOpenApiDocument`, so the served and generated documents match when given the same options.

| Option            | Type                                            | Default | Description                                                  |
| ----------------- | ----------------------------------------------- | ------- | ------------------------------------------------------------ |
| `title`           | `string`                                        | —       | Document title                                               |
| `description`     | `string`                                        | —       | Document description                                         |
| `version`         | `string`                                        | `"1.0"` | Document version                                             |
| `bearerAuth`      | `boolean`                                       | `false` | Adds the `bearer` scheme and requires it on every operation  |
| `customize`       | `(builder: DocumentBuilder) => DocumentBuilder` | —       | Extra builder calls, e.g. `addApiKey(...)`                   |
| `documentOptions` | `SwaggerDocumentOptions`                        | —       | Passed to `SwaggerModule.createDocument`, e.g. `extraModels` |

`buildSwaggerConfig(options)` returns the `DocumentBuilder` config and `createOpenApiDocument(app, options)` returns the full document, for apps that need to post-process it.

## Environment Variables

| Variable       | Required | Default | Description                                                           |
| -------------- | :------: | ------- | --------------------------------------------------------------------- |
| `CORS_ORIGINS` |    ❌    | —       | Comma-separated allowed origins; takes precedence over `FRONTEND_URL` |
| `FRONTEND_URL` |    ❌    | —       | Allowed origin when `CORS_ORIGINS` is unset                           |
| `PORT`         |    ❌    | `3000`  | Application listen port                                               |

## Related Modules

- [Auth](../auth/README.md) — global `JwtAuthGuard` is applied separately via `SharedAuthModule`
- [Database](../database/README.md) — provides the `TypeOrmExceptionFilter` used by `configureApp`
- [Config](../config/README.md) — env validation for the variables above
