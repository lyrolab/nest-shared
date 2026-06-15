# Nest Shared — `@lyrolab/nest-shared`

A collection of shared NestJS modules published to npm as `@lyrolab/nest-shared`. Provides reusable infrastructure components (AI, Auth, Bootstrap, Bull/Queue, Cache, Database, ESLint, Health, Redis) used across LyroLab projects.

## Repository Structure

```
nest-shared/
├── src/
│   ├── ai/           # OpenRouter AI service with caching
│   ├── auth/         # JWT/Keycloak authentication
│   ├── bootstrap/    # App setup (CORS, ValidationPipe, Swagger)
│   ├── bull/         # BullMQ queue integration
│   ├── cache/        # Redis-backed caching
│   ├── database/     # TypeORM + PostgreSQL connections
│   ├── eslint/       # Shared ESLint config + custom rules
│   ├── health/       # Health check endpoint (Terminus)
│   ├── queue/        # Job processing with decorators
│   └── redis/        # Low-level Redis config
├── package.json      # Exports map — each module has its own entry
├── eslint.config.mjs # Root ESLint config
└── README.md         # Module catalog table
```

## Conventions

### Module Structure
- Each module lives in `src/<module>/` with its own `index.ts` barrel export.
- Every module **must** have a `README.md` in its directory explaining what it does, how to use it, and what configuration it requires.

### Adding a New Module
1. Create `src/<module>/` with an `index.ts` that re-exports all public symbols.
2. Write a `README.md` for the module.
3. Add an entry to the `exports` map in `package.json`:

```json
"./<module>": {
  "types": "./dist/<module>/index.d.ts",
  "import": "./dist/<module>/index.js",
  "require": "./dist/<module>/index.js"
}
```

4. Update the root `README.md` module catalog table to include the new module.

### Code Style
- TypeScript, NestJS conventions.
- Use `@nestjs/common` decorators and patterns.
- Dynamic modules use `forRoot()` / `forRootAsync()` / `forTest()` naming.
- Tests use Jest and live alongside source files (`*.spec.ts`).

## Releases

This package uses **semantic-release** for automated publishing. Releases are triggered by pushing to the `main` branch.

### Commit Convention

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: ...` — minor release (new feature)
- `fix: ...` — patch release (bug fix)
- `feat!: ...` or `fix!: ...` — major release (breaking change)
- `chore:`, `docs:`, `refactor:`, `test:`, `style:` — no release

### Release Workflow

```bash
git commit -m "feat: add new module for X"
git push origin main
# semantic-release CI pipeline will:
#   1. Determine next version from commits
#   2. Generate changelog
#   3. Publish to npm
#   4. Create GitHub release
```

## Local Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Test
npm test

# Lint
npm run lint

# Watch mode
npm run dev
```
