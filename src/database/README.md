# Database Module

The database module provides a standardized way to connect to and interact with databases across our NestJS applications. It includes built-in support for test environments using TestContainers and production environments using PostgreSQL.

## Dependencies

The database module requires the following packages:

```bash
npm install @nestjs/config @nestjs/typeorm typeorm pg
```

## Features

- Automatic test environment configuration using TestContainers
- Production environment configuration using DATABASE_URL from ConfigService
- Support for custom entities and migrations paths
- Automatic database synchronization in test environment
- Built-in test database cleanup utilities

## Usage

1. Import the database module in your `app.module.ts`:

```typescript
import { SharedDatabaseModule } from "@lyrolab/nest-shared/database"

@Module({
  imports: [
    SharedDatabaseModule.forRoot({
      // Optional: Specify custom paths for entities and migrations
      entities: ["path/to/entities/**/*.entity{.ts,.js}"],
      migrations: ["path/to/migrations/**/*.{ts,js}"],
    }),
  ],
})
export class AppModule {}
```

## Configuration

The module automatically configures itself based on the environment:

### Test Environment (`NODE_ENV=test`)

- Creates a PostgreSQL container using TestContainers
- Automatically synchronizes the database schema
- Provides utilities for database cleanup between tests

### Production Environment

- Uses the DATABASE_URL from ConfigService
- Disables automatic schema synchronization
- Supports custom entities and migrations paths

## Environment Variables

- `DATABASE_URL`: Required in production environment
- `NODE_ENV`: Set to 'test' for test environment configuration

## TypeORM CLI Data Source

`createCliDataSource(AppModule)` boots the application context, takes the `DataSource` configured by `SharedDatabaseModule`, closes the context and returns the data source for the TypeORM CLI to initialize. Entities and migrations therefore come from the same configuration as the running app.

```typescript
// src/data-source.ts
import { createCliDataSource } from "@lyrolab/nest-shared/database"
import { AppModule } from "./app.module"

export default createCliDataSource(AppModule)
```

The context boots every module, so the CLI needs the same environment as the app (`DATABASE_URL`, `REDIS_URL`, …).

### Script Convention

Every backend exposes the same database scripts in its `package.json`:

```json
{
  "scripts": {
    "typeorm": "typeorm-ts-node-commonjs -d ./src/data-source.ts",
    "db:migrate": "npm run build && npm run typeorm -- migration:run",
    "db:generate": "npm run typeorm -- migration:generate ./src/migrations/$npm_config_name && eslint src/migrations/*-$npm_config_name.ts --fix",
    "db:seed": "ts-node -r tsconfig-paths/register src/seed/seed.ts"
  }
}
```

| Script        | Purpose                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| `db:migrate`  | Runs pending migrations. Builds first because `SharedDatabaseModule` loads migrations from `dist/migrations` |
| `db:generate` | Generates a migration from the entity diff: `npm run db:generate --name=add-user-email`                      |
| `db:seed`     | Inserts development fixtures; must refuse to run against production                                          |
