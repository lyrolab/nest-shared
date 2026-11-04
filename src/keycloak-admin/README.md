# Keycloak Admin Module — `@lyrolab/nest-shared/keycloak-admin`

Keycloak admin client limited to user operations. Authenticates with the client-credentials grant of a service-account client and calls the Keycloak Admin REST API.

## What Is This?

A dynamic NestJS module providing `KeycloakAdminService`:

- `getUser(userId)` reads the Keycloak user whose id is `userId` (the `sub` of their tokens)
- `updateUser(userId, patch)` changes the username, email, `emailVerified`, first and last name, or any attribute
- `logoutUser(userId)` ends every session of the user
- `executeActionsEmail(userId, actions, options)` emails the user a link running required actions such as `VERIFY_EMAIL`
- `listCredentials(userId)` lists the user's credentials (`password`, `otp`, …) without their secrets
- `deleteUser(userId)` deletes the user
- Access tokens are cached until 30 seconds before they expire, shared between concurrent calls, and refreshed once when Keycloak rejects a cached token
- Failures surface as typed errors; the client secret never appears in error messages
- `forTest()` swaps in an in-memory stub that implements every operation and records its calls

It talks to Keycloak over plain `fetch`, with no dependency on `@keycloak/keycloak-admin-client`.

## How Do I Use It?

### 1. Create the Service-Account Client in Keycloak

In the realm holding your users:

1. Create a confidential OpenID Connect client (e.g. `my-backend-admin`) with **Client authentication** and **Service accounts roles** enabled, and every login flow disabled.
2. In **Service account roles**, assign only the `realm-management` client role `manage-users`.

Keep this client separate from the one users log in to, and give it no other roles: its secret can change and delete any user of the realm.

To rename users, the realm needs **Edit username** (`editUsernameAllowed`) on; without it Keycloak refuses a new username with `error-user-attribute-read-only`, even from this client. An attribute outside the realm's user profile is kept only when the profile's unmanaged attribute policy allows it; `locale` is kept when the realm has internationalization on.

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

### 4. Change a User

```typescript
import { ConflictException, Injectable } from "@nestjs/common"
import {
  KeycloakAdminService,
  KeycloakUserConflictError,
} from "@lyrolab/nest-shared/keycloak-admin"

@Injectable()
export class EmailChangeService {
  constructor(private readonly keycloakAdmin: KeycloakAdminService) {}

  async changeEmail(sub: string, email: string) {
    try {
      await this.keycloakAdmin.updateUser(sub, { email, emailVerified: false })
    } catch (error) {
      if (error instanceof KeycloakUserConflictError) {
        throw new ConflictException("email_taken")
      }
      throw error
    }
    await this.keycloakAdmin.executeActionsEmail(sub, ["VERIFY_EMAIL"], {
      clientId: "my-frontend",
      redirectUri: "https://app.example.com/account",
      lifespan: 3600,
    })
  }
}
```

`updateUser` sends only the fields the patch sets. Keycloak keeps `emailVerified` when the email changes, so pass `emailVerified: false` to have the new address verified.

A patch with `attributes` is merged into the user's current attributes: the service reads the user, then sends the whole profile, because Keycloak clears the username, email, names and attributes left out of a body that carries attributes. An empty list removes an attribute. Two concurrent attribute updates of the same user can overwrite each other.

### 5. Test with the Stub

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
stub.seedUser({
  id: "user-sub",
  username: "olive",
  email: "olive@example.com",
  credentials: [{ id: "otp-1", type: "otp", userLabel: "phone" }],
})
// ... exercise the code under test
expect(stub.calls).toContainEqual({
  operation: "executeActionsEmail",
  userId: "user-sub",
  actions: ["VERIFY_EMAIL"],
  options: expect.objectContaining({ clientId: "my-frontend" }),
})
expect(stub.deletedUserIds).toEqual(["user-sub"])
```

`forTest()` provides `KeycloakAdminStubService` under the `KeycloakAdminService` token. It behaves like Keycloak for what an app relies on:

- Every user exists until deleted once; a user never seeded reads as `{ id, username: id }` with no email and no credentials. After deletion every operation throws `KeycloakUserNotFoundError`.
- Usernames and emails are stored lowercase, and taking one another user has throws `KeycloakUserConflictError` with `field` `username` or `email`.
- `updateUser` merges attributes like the real service; an empty list removes one.
- `executeActionsEmail` to a user without email throws `KeycloakUserValidationError`, as Keycloak answers 400.
- `calls` records every operation with its arguments, failed ones included; `deletedUserIds` lists the deleted users.

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

| Error                              | Raised when                                                                                                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KeycloakAdminAuthenticationError` | The token endpoint rejects the client credentials, or a fresh token is refused                                                                                                                  |
| `KeycloakAdminForbiddenError`      | The service account lacks the role for the operation (HTTP 403)                                                                                                                                 |
| `KeycloakUserNotFoundError`        | The user does not exist (HTTP 404); exposes `userId`                                                                                                                                            |
| `KeycloakUserConflictError`        | Another user has the username or email (HTTP 409); exposes `userId` and `field` (`username` or `email`)                                                                                         |
| `KeycloakUserValidationError`      | Keycloak refused a value (HTTP 400), e.g. a username failing the user profile's validators or an actions email to a user without email; exposes `userId`, `field` and Keycloak's `errorMessage` |
| `KeycloakAdminRequestError`        | Any other status, a malformed token response, an invalid user id, a network error or a timeout                                                                                                  |

## Key Exports

| Export                       | Type      | Description                                                                                                               |
| ---------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------- |
| `KeycloakAdminModule`        | class     | Dynamic module with `forRootAsync()` / `forTest()`                                                                        |
| `KeycloakAdminService`       | class     | `getUser`, `updateUser`, `logoutUser`, `executeActionsEmail`, `listCredentials`, `deleteUser`                             |
| `KeycloakAdminStubService`   | class     | In-memory stub provided by `forTest()`, with `seedUser()`, `calls` and `deletedUserIds`                                   |
| `KeycloakAdminOptions`       | interface | Module options                                                                                                            |
| `KeycloakUser`               | interface | `{ id; username; email?; emailVerified; firstName?; lastName?; enabled; createdTimestamp?; attributes; requiredActions }` |
| `KeycloakUserPatch`          | interface | Fields `updateUser` changes                                                                                               |
| `KeycloakCredential`         | interface | `{ id; type; userLabel?; createdDate? }`                                                                                  |
| `ExecuteActionsEmailOptions` | interface | `{ clientId?; redirectUri?; lifespan? }` (lifespan in seconds)                                                            |
| `KEYCLOAK_ADMIN_OPTIONS`     | token     | Injection token for the options                                                                                           |

## Development

`keycloak-admin.integration.spec.ts` starts a Keycloak container with Testcontainers and runs as part of `npm test`, so the suite needs a running Docker daemon.
