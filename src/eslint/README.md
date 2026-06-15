# ESLint Module — `@lyrolab/nest-shared/eslint`

Shared ESLint configuration and custom NestJS architecture rules for the monorepo.

## What Is This?

Provides:

1. **`nestArchitecturePlugin`** — an ESLint plugin with three custom rules that enforce NestJS architecture best practices
2. **Shared ESLint config** — a flat config file (`eslint.config.mjs`) usable across projects

## Custom Rules

### `@lyrolab/nestjs-architecture/no-typeorm-in-non-repository`

Prevents importing TypeORM decorators and utilities (like `@Entity`, `@Column`, `getRepository`) outside of repository files.

```typescript
// ❌ Bad — TypeORM in a service
import { Entity } from "typeorm"

// ✅ Good — TypeORM only in repository files
```

### `@lyrolab/nestjs-architecture/no-repository-in-controller`

Prevents injecting repositories directly into controllers. Controllers should use services.

```typescript
// ❌ Bad — repository injected in controller
@Controller()
export class UserController {
  constructor(private repo: Repository<User>) {}
}

// ✅ Good — service injected in controller
@Controller()
export class UserController {
  constructor(private userService: UserService) {}
}
```

### `@lyrolab/nestjs-architecture/no-export-repository-in-module`

Prevents exporting repository providers from modules. Repositories should be encapsulated behind services.

## How Do I Use It?

### In ESLint Flat Config

```javascript
// eslint.config.mjs
import { nestArchitecturePlugin } from "@lyrolab/nest-shared/eslint"

export default [
  {
    plugins: {
      "@lyrolab/nestjs-architecture": nestArchitecturePlugin,
    },
    rules: {
      ...nestArchitecturePlugin.configs.recommended.rules,
      // Or selectively:
      "@lyrolab/nestjs-architecture/no-typeorm-in-non-repository": "error",
    },
  },
]
```

### The recommended config applies all three rules as errors:

```javascript
"@lyrolab/nestjs-architecture/no-typeorm-in-non-repository": "error"
"@lyrolab/nestjs-architecture/no-repository-in-controller": "error"
"@lyrolab/nestjs-architecture/no-export-repository-in-module": "error"
```

## What It Exports

| Export | Type | Description |
|--------|------|-------------|
| `nestArchitecturePlugin` | object | ESLint plugin with `rules` and `configs.recommended` |
| `noTypeormInNonRepository` | rule | Individual rule (via destructuring from source) |
| `noRepositoryInController` | rule | Individual rule |
| `noExportRepositoryInModule` | rule | Individual rule |

## Related Files

The root `eslint.config.mjs` at the project root contains the global ESLint configuration used for development of the nest-shared package itself.
