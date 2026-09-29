# Auth Module — `@lyrolab/nest-shared/auth`

JWT-based authentication module with Keycloak integration. Validates JWTs using a JWKS endpoint, exposes Keycloak roles, provisions local users, and provides decorators for route protection and user access.

## What Is This?

A dynamic NestJS module that configures Passport with a JWT strategy backed by JWKS (JSON Web Key Set). It:

- Validates Bearer tokens against a JWKS URI, pinned to `RS256`
- Supports a single static issuer, or **multiple issuers resolved from the token's `iss` at request time**
- Verifies the token `issuer` and (when configured) `audience` claims
- Provides `@Public()` to bypass auth on specific routes
- Provides `@CurrentUser()` to extract authenticated user info
- Reads Keycloak realm and client roles into `AuthUser.roles`, enforced with `@Roles()` and `RolesGuard`
- Provisions local users keyed on `(issuer, subject)` with `createUserProvisioningGuard()`
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

### 7. Protect Routes with Roles

`AuthUser.roles` holds the token's `realm_access.roles` plus `resource_access[clientId].roles`
for the configured `clientId`. Register `RolesGuard` after `JwtAuthGuard` and annotate
routes or controllers with `@Roles()`. A caller needs **any one** of the listed roles;
handler-level `@Roles()` overrides controller-level. Routes without `@Roles()` are
unaffected, and a role-protected route without an authenticated user returns 403.

```typescript
import { APP_GUARD } from "@nestjs/core"
import {
  JwtAuthGuard,
  Roles,
  RolesGuard,
  SharedAuthModule,
} from "@lyrolab/nest-shared/auth"

@Module({
  imports: [
    SharedAuthModule.forRoot({
      ...keycloakConfig(url, realm),
      audience: "my-backend",
      clientId: "my-backend",
    }),
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}

@Controller("admin")
export class AdminController {
  @Roles("admin")
  @Get()
  dashboard() {}
}
```

In dynamic mode, roles are read only from issuers whose `resolveIssuer` result sets
`trustRoles: true` (with an optional per-issuer `clientId`). Every other issuer
authenticates with `roles: []`, so a tenant-controlled IdP cannot mint application
roles.

### 8. Provision Local Users

`createUserProvisioningGuard()` builds a guard that maps the verified caller to the
app's own user record. The app implements `UserProvisioner`; the guard calls it with
the caller's `ProvisioningIdentity` and writes the result to `request.dbUser` (or
`requestProperty`).

Users are keyed on **`(issuer, subject)`**: the same `sub` from two issuers is two
users. The provisioner must look up and store both, never `subject` alone.

```typescript
import {
  createUserProvisioningGuard,
  JwtAuthGuard,
  ProvisioningIdentity,
  RolesGuard,
  UserProvisioner,
} from "@lyrolab/nest-shared/auth"

@Injectable()
export class AppUserProvisioner implements UserProvisioner<User> {
  constructor(private readonly users: UserRepository) {}

  provision({ issuer, subject, email, name }: ProvisioningIdentity) {
    return this.users.findOrCreate({ issuer, subject }, { email, name })
  }
}

@Module({
  providers: [
    AppUserProvisioner,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    {
      provide: APP_GUARD,
      useClass: createUserProvisioningGuard({
        provisioner: AppUserProvisioner,
        cacheTtlMs: 30_000,
      }),
    },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AuthModule {}
```

- Nest runs global guards in registration order; register the provisioning guard
  **after** `JwtAuthGuard`, since it trusts `request.user`.
- Requests without `request.user` (public routes) pass through unprovisioned.
- A caller without a verified issuer or subject, or a provisioner returning
  `null`/`undefined`, is rejected with 401. Exceptions thrown by the provisioner
  propagate, so it can refuse a user (e.g. an issuer no tenant owns).
- `cacheTtlMs` caches provisioned users in `CACHE_MANAGER` (e.g. `SharedCacheModule`)
  under an `(issuer, subject)` key. Cached values go through the cache store's
  serialization, so with Redis they come back as plain objects, not entity instances.

## Configuration

Options take one of two shapes. Both accept an optional `algorithms` allowlist
(default `['RS256']`).

**Static (single issuer):**

| Option     | Type                 | Required | Description                                               |
| ---------- | -------------------- | :------: | --------------------------------------------------------- |
| `jwksUri`  | `string`             |    ✅    | JWKS endpoint URL for key retrieval                       |
| `issuer`   | `string`             |    ✅    | Expected JWT issuer                                       |
| `audience` | `string \| string[]` |    —     | Expected JWT audience, verified when set                  |
| `clientId` | `string`             |    —     | Client whose `resource_access` roles are added to `roles` |

**Dynamic (multiple issuers):**

| Option          | Type                                               | Required | Description                                                          |
| --------------- | -------------------------------------------------- | :------: | -------------------------------------------------------------------- |
| `resolveIssuer` | `(iss: string) => Promise<ResolvedIssuer \| null>` |    ✅    | Maps a token's `iss` to its signing config; `null` rejects the token |

`ResolvedIssuer`:

| Field        | Type                 | Required | Description                                                         |
| ------------ | -------------------- | :------: | ------------------------------------------------------------------- |
| `jwksUri`    | `string`             |    ✅    | JWKS endpoint of the issuer                                         |
| `audience`   | `string \| string[]` |    —     | Expected audience, verified when set                                |
| `trustRoles` | `boolean`            |    —     | Reads this issuer's roles into `AuthUser.roles` (default `false`)   |
| `clientId`   | `string`             |    —     | Client whose `resource_access` roles are read when `trustRoles` set |

**`createUserProvisioningGuard(options)`:**

| Option            | Type             | Required | Description                                               |
| ----------------- | ---------------- | :------: | --------------------------------------------------------- |
| `provisioner`     | `InjectionToken` |    ✅    | Provider implementing `UserProvisioner`                   |
| `requestProperty` | `string`         |    —     | Request property receiving the user (default `dbUser`)    |
| `cacheTtlMs`      | `number`         |    —     | Caches provisioned users in `CACHE_MANAGER` for this long |

## Environment Variables

| Variable     | Required | Description                           |
| ------------ | :------: | ------------------------------------- |
| `JWKS_URI`   |    ✅    | JWKS endpoint (used with async setup) |
| `JWT_ISSUER` |    ✅    | JWT issuer (used with async setup)    |

## Key Exports

| Export                                 | Type            | Description                                                                                |
| -------------------------------------- | --------------- | ------------------------------------------------------------------------------------------ |
| `SharedAuthModule`                     | class           | Dynamic module with `forRoot()` / `forRootAsync()`                                         |
| `JwtAuthGuard`                         | class           | Global auth guard (respects `@Public()`)                                                   |
| `Public()`                             | decorator       | Marks a route as publicly accessible                                                       |
| `CurrentUser()`                        | param decorator | Injects `AuthUser` from JWT payload                                                        |
| `AuthUser`                             | interface       | `{ id; email?; name?; issuer?; roles? }` — `issuer` and `roles` always set by the strategy |
| `Roles(...roles)`                      | decorator       | Requires any one of the roles on a route or controller                                     |
| `RolesGuard`                           | class           | Enforces `@Roles()`; register after `JwtAuthGuard`                                         |
| `createUserProvisioningGuard(options)` | function        | Builds a guard provisioning users through a `UserProvisioner`                              |
| `UserProvisioner`                      | interface       | `provision(identity: ProvisioningIdentity): Promise<TUser>`                                |
| `ProvisioningIdentity`                 | interface       | `{ issuer; subject; email?; name?; roles }`                                                |
| `provisioningCacheKey(iss, sub)`       | function        | Cache key used by the provisioning guard (for invalidation)                                |
| `JwtPayload`                           | interface       | Raw JWT payload shape                                                                      |
| `keycloakConfig(url, realm)`           | function        | Returns `{ jwksUri, issuer }` for Keycloak                                                 |
| `AuthModuleOptions`                    | type            | `StaticAuthOptions \| DynamicAuthOptions`                                                  |
| `StaticAuthOptions`                    | interface       | Single-issuer config `{ jwksUri, issuer, audience?, algorithms?, clientId? }`              |
| `DynamicAuthOptions`                   | interface       | Multi-issuer config `{ resolveIssuer, algorithms? }`                                       |
| `ResolvedIssuer`                       | interface       | `{ jwksUri; audience?; trustRoles?; clientId? }`                                           |
| `isDynamicAuthOptions`                 | function        | Type guard distinguishing the two option shapes                                            |
| `AUTH_MODULE_OPTIONS`                  | token           | Injection token for auth options                                                           |

## Related Modules

- [Bootstrap](../bootstrap/README.md) — use `configureApp()` to set up global guards if you need custom guard application.
- [Health](../health/README.md) — the `/health` endpoint is automatically excluded from auth.
