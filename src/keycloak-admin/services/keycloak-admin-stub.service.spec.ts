import { Test } from "@nestjs/testing"
import {
  KeycloakUserConflictError,
  KeycloakUserNotFoundError,
  KeycloakUserValidationError,
} from "../errors/keycloak-admin.errors"
import { KeycloakAdminModule } from "../keycloak-admin.module"
import { KeycloakAdminStubService } from "./keycloak-admin-stub.service"
import { KeycloakAdminService } from "./keycloak-admin.service"

describe("KeycloakAdminStubService", () => {
  let service: KeycloakAdminService
  let stub: KeycloakAdminStubService

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [KeycloakAdminModule.forTest()],
    }).compile()
    service = moduleRef.get(KeycloakAdminService)
    stub = moduleRef.get(KeycloakAdminStubService)
  })

  it("reads a seeded user with Keycloak's lowercasing", async () => {
    stub.seedUser({
      id: "user-1",
      username: "Olive.R",
      email: "Olive@Example.com",
      attributes: { birthdate: ["1990-05-06"] },
    })

    expect(await service.getUser("user-1")).toEqual({
      id: "user-1",
      username: "olive.r",
      email: "olive@example.com",
      emailVerified: false,
      enabled: true,
      attributes: { birthdate: ["1990-05-06"] },
      requiredActions: [],
    })
  })

  it("reads a user never seeded as a bare user", async () => {
    expect(await service.getUser("User-2")).toMatchObject({
      id: "User-2",
      username: "user-2",
      attributes: {},
    })
  })

  it("returns copies the caller cannot mutate", async () => {
    stub.seedUser({ id: "user-1", attributes: { locale: ["en"] } })

    const user = await service.getUser("user-1")
    user.attributes.locale = ["fr"]

    expect((await service.getUser("user-1")).attributes.locale).toEqual(["en"])
  })

  it("updates the given fields and merges attributes", async () => {
    stub.seedUser({
      id: "user-1",
      email: "old@example.com",
      emailVerified: true,
      attributes: { birthdate: ["1990-05-06"], locale: ["en"] },
    })

    await service.updateUser("user-1", {
      username: "New.Name",
      email: "New@Example.com",
      firstName: undefined,
      attributes: { locale: ["fr"], birthdate: [] },
    })

    expect(await service.getUser("user-1")).toMatchObject({
      username: "new.name",
      email: "new@example.com",
      emailVerified: true,
      attributes: { locale: ["fr"] },
    })
    expect(stub.calls).toContainEqual({
      operation: "updateUser",
      userId: "user-1",
      patch: {
        username: "New.Name",
        email: "New@Example.com",
        firstName: undefined,
        attributes: { locale: ["fr"], birthdate: [] },
      },
    })
  })

  it("refuses a username or email another user has, ignoring case", async () => {
    stub.seedUser({ id: "a", username: "olive", email: "olive@example.com" })
    stub.seedUser({ id: "b", username: "bob", email: "bob@example.com" })

    await expect(
      service.updateUser("b", { username: "OLIVE" }),
    ).rejects.toMatchObject({ field: "username", status: 409 })
    await expect(
      service.updateUser("b", { email: "Olive@Example.com" }),
    ).rejects.toBeInstanceOf(KeycloakUserConflictError)
    await expect(
      service.updateUser("b", { email: "Olive@Example.com" }),
    ).rejects.toMatchObject({ field: "email" })
    await expect(
      service.updateUser("a", { username: "Olive" }),
    ).resolves.toBeUndefined()
  })

  it("refuses an empty username", async () => {
    await expect(
      service.updateUser("a", { username: " " }),
    ).rejects.toBeInstanceOf(KeycloakUserValidationError)
  })

  it("records logouts and actions emails", async () => {
    stub.seedUser({ id: "user-1", email: "olive@example.com" })

    await service.logoutUser("user-1")
    await service.executeActionsEmail("user-1", ["VERIFY_EMAIL"], {
      clientId: "web",
      redirectUri: "https://app.example.com/me",
      lifespan: 3600,
    })

    expect(stub.calls).toEqual([
      { operation: "logoutUser", userId: "user-1" },
      {
        operation: "executeActionsEmail",
        userId: "user-1",
        actions: ["VERIFY_EMAIL"],
        options: {
          clientId: "web",
          redirectUri: "https://app.example.com/me",
          lifespan: 3600,
        },
      },
    ])
  })

  it("refuses an actions email to a user without email", async () => {
    await expect(
      service.executeActionsEmail("user-1", ["VERIFY_EMAIL"]),
    ).rejects.toMatchObject({
      name: "KeycloakUserValidationError",
      status: 400,
    })
  })

  it("refuses an actions email to a disabled user", async () => {
    stub.seedUser({ id: "user-1", email: "olive@example.com", enabled: false })

    await expect(
      service.executeActionsEmail("user-1", ["VERIFY_EMAIL"]),
    ).rejects.toMatchObject({
      name: "KeycloakUserValidationError",
      errorMessage: "User is disabled",
    })
  })

  it("reads cleared email and names as absent", async () => {
    stub.seedUser({
      id: "user-1",
      email: "olive@example.com",
      firstName: "Olive",
      lastName: "R",
    })

    await service.updateUser("user-1", {
      email: "",
      firstName: "",
      lastName: "",
    })

    const user = await service.getUser("user-1")
    expect(user.email).toBeUndefined()
    expect(user.firstName).toBeUndefined()
    expect(user.lastName).toBeUndefined()
  })

  it("lists seeded credentials", async () => {
    stub.seedUser({
      id: "user-1",
      credentials: [
        { id: "c1", type: "password" },
        { id: "c2", type: "otp", userLabel: "phone" },
      ],
    })

    expect(await service.listCredentials("user-1")).toEqual([
      { id: "c1", type: "password" },
      { id: "c2", type: "otp", userLabel: "phone" },
    ])
    expect(await service.listCredentials("user-2")).toEqual([])
  })

  it("forgets a deleted user for every operation", async () => {
    stub.seedUser({ id: "user-1", email: "olive@example.com" })

    await service.deleteUser("user-1")

    expect(stub.deletedUserIds).toEqual(["user-1"])
    for (const run of [
      () => service.getUser("user-1"),
      () => service.updateUser("user-1", { email: "x@example.com" }),
      () => service.logoutUser("user-1"),
      () => service.executeActionsEmail("user-1", ["VERIFY_EMAIL"]),
      () => service.listCredentials("user-1"),
      () => service.deleteUser("user-1"),
    ]) {
      await expect(run()).rejects.toBeInstanceOf(KeycloakUserNotFoundError)
    }
  })
})
