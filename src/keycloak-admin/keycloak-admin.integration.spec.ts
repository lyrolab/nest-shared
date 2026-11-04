import { Test } from "@nestjs/testing"
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers"
import {
  KeycloakAdminAuthenticationError,
  KeycloakAdminForbiddenError,
  KeycloakUserConflictError,
  KeycloakUserNotFoundError,
} from "./errors/keycloak-admin.errors"
import { KeycloakAdminOptions } from "./interfaces/keycloak-admin-options.interface"
import { KeycloakAdminModule } from "./keycloak-admin.module"
import { KeycloakAdminService } from "./services/keycloak-admin.service"

const KEYCLOAK_IMAGE = "quay.io/keycloak/keycloak:26.4"
const REALM = "nest-shared-it"
const MANAGER_CLIENT = "user-manager"
const UNPRIVILEGED_CLIENT = "no-roles"

jest.setTimeout(240_000)

class KeycloakFixture {
  private masterToken = ""

  constructor(readonly url: string) {}

  async login(): Promise<void> {
    const response = await fetch(
      `${this.url}/realms/master/protocol/openid-connect/token`,
      {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "password",
          client_id: "admin-cli",
          username: "admin",
          password: "admin",
        }),
      },
    )
    this.masterToken = (
      (await response.json()) as { access_token: string }
    ).access_token
  }

  async admin(method: string, path: string, body?: unknown) {
    const response = await fetch(`${this.url}/admin/realms${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.masterToken}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok && response.status !== 404) {
      throw new Error(`${method} ${path}: HTTP ${response.status}`)
    }
    return response
  }

  async createServiceClient(clientId: string): Promise<string> {
    const created = await this.admin("POST", `/${REALM}/clients`, {
      clientId,
      publicClient: false,
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
    })
    const id = locationId(created)
    const secret = (await (
      await this.admin("GET", `/${REALM}/clients/${id}/client-secret`)
    ).json()) as { value: string }
    return secret.value
  }

  async grantManageUsers(clientId: string): Promise<void> {
    const [client] = (await (
      await this.admin("GET", `/${REALM}/clients?clientId=${clientId}`)
    ).json()) as { id: string }[]
    const serviceAccount = (await (
      await this.admin(
        "GET",
        `/${REALM}/clients/${client.id}/service-account-user`,
      )
    ).json()) as { id: string }
    const [realmManagement] = (await (
      await this.admin("GET", `/${REALM}/clients?clientId=realm-management`)
    ).json()) as { id: string }[]
    const role = (await (
      await this.admin(
        "GET",
        `/${REALM}/clients/${realmManagement.id}/roles/manage-users`,
      )
    ).json()) as { id: string; name: string }
    await this.admin(
      "POST",
      `/${REALM}/users/${serviceAccount.id}/role-mappings/clients/${realmManagement.id}`,
      [role],
    )
  }

  async createUser(
    username: string,
    fields: Record<string, unknown> = {},
  ): Promise<string> {
    return locationId(
      await this.admin("POST", `/${REALM}/users`, {
        username,
        enabled: true,
        ...fields,
      }),
    )
  }

  async enableUnmanagedAttributes(): Promise<void> {
    const profile = (await (
      await this.admin("GET", `/${REALM}/users/profile`)
    ).json()) as Record<string, unknown>
    await this.admin("PUT", `/${REALM}/users/profile`, {
      ...profile,
      unmanagedAttributePolicy: "ENABLED",
    })
  }

  async setPassword(userId: string, password: string): Promise<void> {
    await this.admin("PUT", `/${REALM}/users/${userId}/reset-password`, {
      type: "password",
      value: password,
      temporary: false,
    })
  }

  async userExists(id: string): Promise<boolean> {
    return (await this.admin("GET", `/${REALM}/users/${id}`)).status === 200
  }
}

function locationId(response: Response): string {
  const location = response.headers.get("location")
  if (!location) throw new Error("missing Location header")
  return location.substring(location.lastIndexOf("/") + 1)
}

async function serviceFor(
  options: KeycloakAdminOptions,
): Promise<KeycloakAdminService> {
  const moduleRef = await Test.createTestingModule({
    imports: [KeycloakAdminModule.forRootAsync({ useFactory: () => options })],
  }).compile()
  return moduleRef.get(KeycloakAdminService)
}

describe("KeycloakAdminService against Keycloak", () => {
  let container: StartedTestContainer
  let keycloak: KeycloakFixture
  let managerSecret: string
  let unprivilegedSecret: string

  beforeAll(async () => {
    container = await new GenericContainer(KEYCLOAK_IMAGE)
      .withCommand(["start-dev"])
      .withEnvironment({
        KC_BOOTSTRAP_ADMIN_USERNAME: "admin",
        KC_BOOTSTRAP_ADMIN_PASSWORD: "admin",
      })
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forHttp("/realms/master", 8080).forStatusCode(200))
      .withStartupTimeout(180_000)
      .start()

    keycloak = new KeycloakFixture(
      `http://${container.getHost()}:${container.getMappedPort(8080)}`,
    )
    await keycloak.login()
    await keycloak.admin("POST", "", {
      realm: REALM,
      enabled: true,
      editUsernameAllowed: true,
      internationalizationEnabled: true,
      supportedLocales: ["en", "fr"],
    })
    await keycloak.enableUnmanagedAttributes()
    managerSecret = await keycloak.createServiceClient(MANAGER_CLIENT)
    await keycloak.grantManageUsers(MANAGER_CLIENT)
    unprivilegedSecret = await keycloak.createServiceClient(UNPRIVILEGED_CLIENT)
  })

  afterAll(async () => {
    await container?.stop()
  })

  const managerOptions = (): KeycloakAdminOptions => ({
    url: keycloak.url,
    realm: REALM,
    clientId: MANAGER_CLIENT,
    clientSecret: managerSecret,
  })

  it("deletes a user", async () => {
    const userId = await keycloak.createUser("to-delete")
    const service = await serviceFor(managerOptions())

    await service.deleteUser(userId)

    expect(await keycloak.userExists(userId)).toBe(false)
  })

  it("reads and updates a user, keeping the attributes it leaves out", async () => {
    const userId = await keycloak.createUser("olive", {
      email: "olive@example.com",
      emailVerified: true,
      firstName: "Olive",
      lastName: "R",
      attributes: { birthdate: ["1990-05-06"], locale: ["en"] },
    })
    const service = await serviceFor(managerOptions())

    await service.updateUser(userId, {
      username: "Olive.R",
      email: "olive.r@example.com",
      firstName: "",
      lastName: "",
      attributes: { locale: ["fr"], usernameDisplay: ["Olive.R"] },
    })

    const user = await service.getUser(userId)
    expect(user).toMatchObject({
      id: userId,
      username: "olive.r",
      email: "olive.r@example.com",
      emailVerified: true,
      enabled: true,
      attributes: {
        birthdate: ["1990-05-06"],
        locale: ["fr"],
        usernameDisplay: ["Olive.R"],
      },
    })
    expect(user.firstName).toBeUndefined()
    expect(user.lastName).toBeUndefined()

    await service.updateUser(userId, { emailVerified: false })
    expect(await service.getUser(userId)).toMatchObject({
      email: "olive.r@example.com",
      emailVerified: false,
    })
  })

  it("changes one attribute without clearing the rest of the profile", async () => {
    const userId = await keycloak.createUser("attr-only", {
      email: "attr-only@example.com",
      firstName: "Attr",
      lastName: "Only",
      attributes: { birthdate: ["1990-05-06"], locale: ["en"] },
    })
    const service = await serviceFor(managerOptions())

    await service.updateUser(userId, { attributes: { locale: ["fr"] } })

    expect(await service.getUser(userId)).toMatchObject({
      username: "attr-only",
      email: "attr-only@example.com",
      firstName: "Attr",
      lastName: "Only",
      attributes: { birthdate: ["1990-05-06"], locale: ["fr"] },
    })

    await service.updateUser(userId, { attributes: { birthdate: [] } })

    expect((await service.getUser(userId)).attributes).toEqual({
      locale: ["fr"],
    })
  })

  it("reports a taken username and a taken email as typed conflicts", async () => {
    await keycloak.createUser("patb", { email: "patb@example.com" })
    const userId = await keycloak.createUser("renamer", {
      email: "renamer@example.com",
    })
    const service = await serviceFor(managerOptions())

    await expect(
      service.updateUser(userId, { username: "PATB" }),
    ).rejects.toMatchObject({
      name: KeycloakUserConflictError.name,
      field: "username",
    })
    await expect(
      service.updateUser(userId, { email: "patb@example.com" }),
    ).rejects.toMatchObject({
      name: KeycloakUserConflictError.name,
      field: "email",
    })
  })

  it("lists credentials and signs a user out", async () => {
    const userId = await keycloak.createUser("with-password")
    await keycloak.setPassword(userId, "secret-password")
    const service = await serviceFor(managerOptions())

    expect(await service.listCredentials(userId)).toEqual([
      expect.objectContaining({ type: "password" }),
    ])
    await expect(service.logoutUser(userId)).resolves.toBeUndefined()
  })

  it("reports a missing user on every operation", async () => {
    const missing = "00000000-0000-0000-0000-000000000000"
    const service = await serviceFor(managerOptions())

    for (const run of [
      () => service.getUser(missing),
      () => service.updateUser(missing, { email: "x@example.com" }),
      () => service.logoutUser(missing),
      () => service.executeActionsEmail(missing, ["VERIFY_EMAIL"]),
      () => service.listCredentials(missing),
    ]) {
      await expect(run()).rejects.toBeInstanceOf(KeycloakUserNotFoundError)
    }
  })

  it("reuses its cached token across calls", async () => {
    const first = await keycloak.createUser("cached-1")
    const second = await keycloak.createUser("cached-2")
    const service = await serviceFor(managerOptions())
    const fetchSpy = jest.spyOn(global, "fetch")

    try {
      await service.deleteUser(first)
      await service.deleteUser(second)
      const tokenCalls = fetchSpy.mock.calls.filter(
        ([url]) =>
          typeof url === "string" &&
          url.endsWith("/protocol/openid-connect/token"),
      )
      expect(tokenCalls).toHaveLength(1)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it("reports a missing user as KeycloakUserNotFoundError", async () => {
    const service = await serviceFor(managerOptions())

    await expect(
      service.deleteUser("00000000-0000-0000-0000-000000000000"),
    ).rejects.toBeInstanceOf(KeycloakUserNotFoundError)
  })

  it("rejects wrong client credentials", async () => {
    const service = await serviceFor({
      ...managerOptions(),
      clientSecret: "wrong",
    })

    await expect(service.deleteUser("any")).rejects.toBeInstanceOf(
      KeycloakAdminAuthenticationError,
    )
  })

  it("refuses to delete with a service account lacking manage-users", async () => {
    const userId = await keycloak.createUser("protected")
    const service = await serviceFor({
      ...managerOptions(),
      clientId: UNPRIVILEGED_CLIENT,
      clientSecret: unprivilegedSecret,
    })

    await expect(service.deleteUser(userId)).rejects.toBeInstanceOf(
      KeycloakAdminForbiddenError,
    )
    expect(await keycloak.userExists(userId)).toBe(true)
  })
})
