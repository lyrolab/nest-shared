# Keycloak Admin Module — `@lyrolab/nest-shared/keycloak-admin`

Keycloak admin client limited to user operations. Authenticates with the client-credentials grant of a service-account client and calls the Keycloak Admin REST API.

## What Is This?

A dynamic NestJS module providing `KeycloakAdminService`:

- `deleteUser(userId)` deletes the Keycloak user whose id is `userId` (the `sub` of their tokens)
- Access tokens are cached until 30 seconds before they expire, shared between concurrent calls, and refreshed once when Keycloak rejects a cached token
- Failures surface as typed errors; the client secret never appears in error messages
- `forTest()` swaps in an in-memory stub

It talks to Keycloak over plain `fetch`, with no dependency on `@keycloak/keycloak-admin-client`.

## How Do I Use It?

### 1. Create the Service-Account Client in Keycloak

In the realm holding your users:

1. Create a confidential OpenID Connect client (e.g. `my-backend-admin`) with **Client authentication** and **Service accounts roles** enabled, and every login flow disabled.
2. In **Service account roles**, assign only the `realm-management` client role `manage-users`.

Keep this client separate from the one users log in to, and give it no other roles: its secret can delete any user of the realm.

### 2. Register the Module

```typescript
import { Module } from "@nestjs/common"
import { ConfigModule, ConfigService } from "@nestjs/config"
import { KeycloakAdminModule } from "@lyrolab/nest-shared/keycloak-admin"

@Module({
  imports: [
    KeycloakAdminModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        url: config.getOrThrow<string>("KEYCLOAK_URL"),
        realm: config.getOrThrow<string>("KEYCLOAK_REALM"),
        clientId: config.getOrThrow<string>("KEYCLOAK_ADMIN_CLIENT_ID"),
        clientSecret: config.getOrThrow<string>("KEYCLOAK_ADMIN_CLIENT_SECRET"),
      }),
    }),
  ],
})
export class AccountModule {}
```

### 3. Delete a User

```typescript
import { Injectable } from "@nestjs/common"
import {
  KeycloakAdminService,
  KeycloakUserNotFoundError,
} from "@lyrolab/nest-shared/keycloak-admin"

@Injectable()
export class AccountDeletionService {
  constructor(private readonly keycloakAdmin: KeycloakAdminService) {}

  async deleteAccount(sub: string) {
    try {
      await this.keycloakAdmin.deleteUser(sub)
    } catch (error) {
      if (!(error instanceof KeycloakUserNotFoundError)) throw error
    }
  }
}
```

### 4. Test with the Stub

```typescript
import { Test } from "@nestjs/testing"
import {
  KeycloakAdminModule,
  KeycloakAdminStubService,
} from "@lyrolab/nest-shared/keycloak-admin"

const moduleRef = await Test.createTestingModule({
  imports: [AccountModule],
})
  .overrideModule(KeycloakAdminModule)
  .useModule(KeycloakAdminModule.forTest())
  .compile()

const stub = moduleRef.get(KeycloakAdminStubService)
// ... exercise the code under test
expect(stub.deletedUserIds).toEqual(["user-sub"])
```

`forTest()` provides `KeycloakAdminStubService` under the `KeycloakAdminService` token. Every user exists until deleted once; deleting it again throws `KeycloakUserNotFoundError`.

## Configuration

| Option         | Type     | Required | Description                                          |
| -------------- | -------- | :------: | ---------------------------------------------------- |
| `url`          | `string` |    ✅    | Keycloak base URL, e.g. `https://auth.example.com`   |
| `realm`        | `string` |    ✅    | Realm of the service-account client and of the users |
| `clientId`     | `string` |    ✅    | Service-account client id                            |
| `clientSecret` | `string` |    ✅    | Service-account client secret                        |
| `timeoutMs`    | `number` |    —     | Per-request timeout (default `10000`)                |

## Errors

All errors extend `KeycloakAdminError`, which carries the HTTP `status` when there is one.

| Error                              | Raised when                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `KeycloakAdminAuthenticationError` | The token endpoint rejects the client credentials, or a fresh token is refused                 |
| `KeycloakAdminForbiddenError`      | The service account lacks the role for the operation (HTTP 403)                                |
| `KeycloakUserNotFoundError`        | The user does not exist (HTTP 404); exposes `userId`                                           |
| `KeycloakAdminRequestError`        | Any other status, a malformed token response, an invalid user id, a network error or a timeout |

## Key Exports

| Export                     | Type      | Description                                        |
| -------------------------- | --------- | -------------------------------------------------- |
| `KeycloakAdminModule`      | class     | Dynamic module with `forRootAsync()` / `forTest()` |
| `KeycloakAdminService`     | class     | `deleteUser(userId): Promise<void>`                |
| `KeycloakAdminStubService` | class     | In-memory stub provided by `forTest()`             |
| `KeycloakAdminOptions`     | interface | Module options                                     |
| `KEYCLOAK_ADMIN_OPTIONS`   | token     | Injection token for the options                    |

## Development

`keycloak-admin.integration.spec.ts` starts a Keycloak container with Testcontainers and runs as part of `npm test`, so the suite needs a running Docker daemon.
