# Auth Module — `@lyrolab/nest-shared/auth`

JWT-based authentication module with Keycloak integration. Validates JWTs using a JWKS endpoint and provides decorators for route protection and user access.

## What Is This?

A dynamic NestJS module that configures Passport with a JWT strategy backed by JWKS (JSON Web Key Set). It:

- Validates Bearer tokens against a JWKS URI
- Verifies the token `issuer` claim
- Provides `@Public()` to bypass auth on specific routes
- Provides `@CurrentUser()` to extract authenticated user info
- Applies `JwtAuthGuard` globally — all routes are protected by default

## How Do I Use It?

### 1. Register the Module

```typescript
import { Module } from "@nestjs/common"
import { SharedAuthModule } from "@lyrolab/nest-shared/auth"

@Module({
  imports: [
    SharedAuthModule.forRoot({
      jwksUri: "https://your-keycloak/realms/your-realm/protocol/openid-connect/certs",
      issuer: "https://your-keycloak/realms/your-realm",
    }),
  ],
})
export class AppModule {}
```

Or asynchronously with `ConfigService`:

```typescript
import { Module } from "@nestjs/common"
import { ConfigModule, ConfigService } from "@nestjs/config"
import { SharedAuthModule } from "@lyrolab/nest-shared/auth"

@Module({
  imports: [
    SharedAuthModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        jwksUri: config.getOrThrow<string>("JWKS_URI"),
        issuer: config.getOrThrow<string>("JWT_ISSUER"),
      }),
    }),
  ],
})
export class AppModule {}
```

### 2. Use the Keycloak Helper

```typescript
import { SharedAuthModule, keycloakConfig } from "@lyrolab/nest-shared/auth"

@Module({
  imports: [
    SharedAuthModule.forRoot(
      keycloakConfig(
        process.env.KEYCLOAK_URL ?? "http://localhost:8080",
        process.env.KEYCLOAK_REALM ?? "lyrochat",
      ),
    ),
  ],
})
export class AppModule {}
```

### 3. Mark Routes as Public

```typescript
import { Controller, Get } from "@nestjs/common"
import { Public } from "@lyrolab/nest-shared/auth"

@Controller("auth")
export class AuthController {
  @Public()
  @Get("login")
  login() {
    return { message: "This endpoint does not require authentication" }
  }
}
```

### 4. Access the Current User

```typescript
import { Controller, Get } from "@nestjs/common"
import { CurrentUser, AuthUser } from "@lyrolab/nest-shared/auth"

@Controller("profile")
export class ProfileController {
  @Get()
  getProfile(@CurrentUser() user: AuthUser) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
    }
  }
}
```

### 5. Bypass Auth for Specific Routes (in Guard)

The `JwtAuthGuard` is applied globally. It respects `@Public()` and additionally allows unauthenticated access to `/health` and `/api*` (Swagger docs) endpoints automatically.

## Configuration

| Option | Type | Required | Description |
|--------|------|:--------:|-------------|
| `jwksUri` | `string` | ✅ | JWKS endpoint URL for key retrieval |
| `issuer` | `string` | ✅ | Expected JWT issuer |

## Environment Variables

| Variable | Required | Description |
|----------|:--------:|-------------|
| `JWKS_URI` | ✅ | JWKS endpoint (used with async setup) |
| `JWT_ISSUER` | ✅ | JWT issuer (used with async setup) |

## Key Exports

| Export | Type | Description |
|--------|------|-------------|
| `SharedAuthModule` | class | Dynamic module with `forRoot()` / `forRootAsync()` |
| `JwtAuthGuard` | class | Global auth guard (respects `@Public()`) |
| `Public()` | decorator | Marks a route as publicly accessible |
| `CurrentUser()` | param decorator | Injects `AuthUser` from JWT payload |
| `AuthUser` | interface | `{ id: string; email?: string; name?: string }` |
| `JwtPayload` | interface | Raw JWT payload shape |
| `keycloakConfig(url, realm)` | function | Returns `{ jwksUri, issuer }` for Keycloak |
| `AuthModuleOptions` | interface | `{ jwksUri: string; issuer: string }` |
| `AUTH_MODULE_OPTIONS` | token | Injection token for auth options |

## Related Modules

- [Bootstrap](../bootstrap/README.md) — use `configureApp()` to set up global guards if you need custom guard application.
- [Health](../health/README.md) — the `/health` endpoint is automatically excluded from auth.
