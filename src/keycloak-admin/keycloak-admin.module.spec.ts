import { Test } from "@nestjs/testing"
import { KeycloakUserNotFoundError } from "./errors/keycloak-admin.errors"
import { KeycloakAdminModule } from "./keycloak-admin.module"
import { KeycloakAdminStubService } from "./services/keycloak-admin-stub.service"
import { KeycloakAdminService } from "./services/keycloak-admin.service"

describe("KeycloakAdminModule", () => {
  it("forRootAsync provides a KeycloakAdminService built from the factory", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        KeycloakAdminModule.forRootAsync({
          useFactory: () => ({
            url: "https://kc.example.com",
            realm: "acme",
            clientId: "svc",
            clientSecret: "secret",
          }),
        }),
      ],
    }).compile()

    expect(moduleRef.get(KeycloakAdminService)).toBeInstanceOf(
      KeycloakAdminService,
    )
  })

  it("forTest provides a stub that records deletions", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [KeycloakAdminModule.forTest()],
    }).compile()
    const service = moduleRef.get(KeycloakAdminService)
    const stub = moduleRef.get(KeycloakAdminStubService)

    await service.deleteUser("user-1")

    expect(stub.deletedUserIds).toEqual(["user-1"])
    await expect(service.deleteUser("user-1")).rejects.toBeInstanceOf(
      KeycloakUserNotFoundError,
    )
  })
})
