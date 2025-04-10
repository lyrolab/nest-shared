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
