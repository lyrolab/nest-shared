# Auth Module — `@lyrolab/nest-shared/auth`

JWT-based authentication module with Keycloak integration. Validates JWTs using a JWKS endpoint and provides decorators for route protection and user access.

## What Is This?

A dynamic NestJS module that configures Passport with a JWT strategy backed by JWKS (JSON Web Key Set). It:

- Validates Bearer tokens against a JWKS URI, pinned to `RS256`
- Supports a single static issuer, or **multiple issuers resolved from the token's `iss` at request time**
- Verifies the token `issuer` and (when configured) `audience` claims
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
      jwksUri:
        "https://your-keycloak/realms/your-realm/protocol/openid-connect/certs",
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

### 2. Validate Multiple Issuers (Dynamic Mode)

For multi-tenant setups where each tenant has its own IdP, provide a `resolveIssuer`
function instead of a static `jwksUri` / `issuer`. It maps a token's `iss` to that
issuer's JWKS (and optional `audience`); returning `null` marks the issuer untrusted
and rejects the token. One strategy instance validates tokens from any number of
issuers, and per-issuer JWKS clients are cached internally.

```typescript
import { SharedAuthModule } from "@lyrolab/nest-shared/auth"

@Module({
  imports: [
    SharedAuthModule.forRootAsync({
      imports: [OrganizationModule],
      inject: [OrganizationRepository],
      useFactory: (orgs: OrganizationRepository) => ({
        // Resolve the caller's issuer to its signing config; null => 401.
        resolveIssuer: (iss: string) => orgs.findAuthConfigByIssuer(iss),
      }),
    }),
  ],
})
export class AppModule {}
```

Trust in dynamic mode rests on two independent gates: registry membership (an
unknown `iss` never resolves) and signature verification against the resolved
issuer's current key. The consumer owns where the registry lives (e.g. a database);
the module owns the JWT mechanics.

### 3. Use the Keycloak Helper

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

### 4. Mark Routes as Public

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

### 5. Access the Current User

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

### 6. Bypass Auth for Specific Routes (in Guard)

The `JwtAuthGuard` is applied globally. It respects `@Public()` and additionally allows unauthenticated access to the exact `/health` probe.

## Configuration

Options take one of two shapes. Both accept an optional `algorithms` allowlist
(default `['RS256']`).

**Static (single issuer):**

| Option     | Type                 | Required | Description                              |
| ---------- | -------------------- | :------: | ---------------------------------------- |
| `jwksUri`  | `string`             |    ✅    | JWKS endpoint URL for key retrieval      |
| `issuer`   | `string`             |    ✅    | Expected JWT issuer                      |
| `audience` | `string \| string[]` |    —     | Expected JWT audience, verified when set |

**Dynamic (multiple issuers):**

| Option          | Type                                                                                   | Required | Description                                                          |
| --------------- | -------------------------------------------------------------------------------------- | :------: | -------------------------------------------------------------------- |
| `resolveIssuer` | `(iss: string) => Promise<{ jwksUri: string; audience?: string \| string[] } \| null>` |    ✅    | Maps a token's `iss` to its signing config; `null` rejects the token |

## Environment Variables

| Variable     | Required | Description                           |
| ------------ | :------: | ------------------------------------- |
| `JWKS_URI`   |    ✅    | JWKS endpoint (used with async setup) |
| `JWT_ISSUER` |    ✅    | JWT issuer (used with async setup)    |

## Key Exports

| Export                       | Type            | Description                                                        |
| ---------------------------- | --------------- | ------------------------------------------------------------------ |
| `SharedAuthModule`           | class           | Dynamic module with `forRoot()` / `forRootAsync()`                 |
| `JwtAuthGuard`               | class           | Global auth guard (respects `@Public()`)                           |
| `Public()`                   | decorator       | Marks a route as publicly accessible                               |
| `CurrentUser()`              | param decorator | Injects `AuthUser` from JWT payload                                |
| `AuthUser`                   | interface       | `{ id: string; email?: string; name?: string }`                    |
| `JwtPayload`                 | interface       | Raw JWT payload shape                                              |
| `keycloakConfig(url, realm)` | function        | Returns `{ jwksUri, issuer }` for Keycloak                         |
| `AuthModuleOptions`          | type            | `StaticAuthOptions \| DynamicAuthOptions`                          |
| `StaticAuthOptions`          | interface       | Single-issuer config `{ jwksUri, issuer, audience?, algorithms? }` |
| `DynamicAuthOptions`         | interface       | Multi-issuer config `{ resolveIssuer, algorithms? }`               |
| `ResolvedIssuer`             | interface       | `{ jwksUri: string; audience?: string \| string[] }`               |
| `isDynamicAuthOptions`       | function        | Type guard distinguishing the two option shapes                    |
| `AUTH_MODULE_OPTIONS`        | token           | Injection token for auth options                                   |

## Related Modules

- [Bootstrap](../bootstrap/README.md) — use `configureApp()` to set up global guards if you need custom guard application.
- [Health](../health/README.md) — the `/health` endpoint is automatically excluded from auth.
