import * as http from "http"
import {
  KeycloakUserConflictError,
  KeycloakUserNotFoundError,
  KeycloakUserValidationError,
} from "../errors/keycloak-admin.errors"
import { KeycloakAdminService } from "./keycloak-admin.service"

interface RecordedRequest {
  method: string
  path: string
  query: Record<string, string>
  authorization?: string
  contentType?: string
  body: unknown
}

interface ScriptedResponse {
  status: number
  body?: unknown
}

class FakeKeycloak {
  readonly requests: RecordedRequest[] = []
  private responses: ScriptedResponse[] = []
  private server!: http.Server
  url = ""

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => chunks.push(chunk))
      req.on("end", () => {
        const url = new URL(req.url ?? "/", this.url)
        const raw = Buffer.concat(chunks).toString()
        if (url.pathname.endsWith("/protocol/openid-connect/token")) {
          return send(res, {
            status: 200,
            body: { access_token: "t", expires_in: 300 },
          })
        }
        this.requests.push({
          method: req.method ?? "",
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          authorization: req.headers.authorization,
          contentType: req.headers["content-type"],
          body: raw ? JSON.parse(raw) : undefined,
        })
        send(res, this.responses.shift() ?? { status: 500 })
      })
    })
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", resolve),
    )
    const address = this.server.address() as { port: number }
    this.url = `http://127.0.0.1:${address.port}`
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()))
  }

  respond(...responses: ScriptedResponse[]): void {
    this.responses = responses
  }

  reset(): void {
    this.requests.length = 0
    this.responses = []
  }
}

function send(res: http.ServerResponse, { status, body }: ScriptedResponse) {
  if (body === undefined) {
    res.writeHead(status).end()
    return
  }
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(body))
}

const USER_PATH = "/admin/realms/acme/users/user-1"

const userRepresentation = {
  id: "user-1",
  username: "olive.r",
  email: "olive@example.com",
  emailVerified: true,
  firstName: "Olive",
  enabled: true,
  createdTimestamp: 1793752873000,
  attributes: { birthdate: ["1990-05-06"], locale: ["en"] },
  requiredActions: [],
  access: { manage: true },
}

const sameUsername = {
  status: 409,
  body: { errorMessage: "User exists with same username" },
}
const sameEmail = {
  status: 409,
  body: { errorMessage: "User exists with same email" },
}

describe("KeycloakAdminService user operations", () => {
  const keycloak = new FakeKeycloak()
  let service: KeycloakAdminService

  beforeAll(() => keycloak.start())
  afterAll(() => keycloak.stop())

  beforeEach(() => {
    keycloak.reset()
    service = new KeycloakAdminService({
      url: keycloak.url,
      realm: "acme",
      clientId: "svc",
      clientSecret: "s3cret",
    })
  })

  const operations: [string, (s: KeycloakAdminService) => Promise<unknown>][] =
    [
      ["getUser", (s) => s.getUser("user-1")],
      [
        "updateUser",
        (s) => s.updateUser("user-1", { email: "new@example.com" }),
      ],
      ["logoutUser", (s) => s.logoutUser("user-1")],
      [
        "executeActionsEmail",
        (s) => s.executeActionsEmail("user-1", ["VERIFY_EMAIL"]),
      ],
      ["listCredentials", (s) => s.listCredentials("user-1")],
      ["deleteUser", (s) => s.deleteUser("user-1")],
    ]

  describe.each(operations)("%s", (_name, run) => {
    it("maps a 404 to KeycloakUserNotFoundError", async () => {
      keycloak.respond({ status: 404, body: { error: "User not found" } })

      const error = await run(service).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(KeycloakUserNotFoundError)
      expect(error).toMatchObject({ userId: "user-1", status: 404 })
    })

    it("maps a 409 on the username to a username conflict", async () => {
      keycloak.respond(sameUsername)

      const error = await run(service).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(KeycloakUserConflictError)
      expect(error).toMatchObject({ field: "username", status: 409 })
    })

    it("maps a 409 on the email to an email conflict", async () => {
      keycloak.respond(sameEmail)

      const error = await run(service).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(KeycloakUserConflictError)
      expect(error).toMatchObject({ field: "email", status: 409 })
    })
  })

  describe("getUser", () => {
    it("reads the user", async () => {
      keycloak.respond({ status: 200, body: userRepresentation })

      const user = await service.getUser("user-1")

      expect(keycloak.requests).toMatchObject([
        { method: "GET", path: USER_PATH, authorization: "Bearer t" },
      ])
      expect(user).toEqual({
        id: "user-1",
        username: "olive.r",
        email: "olive@example.com",
        emailVerified: true,
        firstName: "Olive",
        enabled: true,
        createdTimestamp: 1793752873000,
        attributes: { birthdate: ["1990-05-06"], locale: ["en"] },
        requiredActions: [],
      })
    })

    it("defaults missing optional fields", async () => {
      keycloak.respond({ status: 200, body: { id: "user-1", username: "x" } })

      expect(await service.getUser("user-1")).toEqual({
        id: "user-1",
        username: "x",
        emailVerified: false,
        enabled: true,
        attributes: {},
        requiredActions: [],
      })
    })
  })

  describe("updateUser", () => {
    it("sends only the given fields", async () => {
      keycloak.respond({ status: 204 })

      await service.updateUser("user-1", {
        username: "Olive.R",
        email: "new@example.com",
        emailVerified: false,
        firstName: "",
        lastName: "",
      })

      expect(keycloak.requests).toEqual([
        expect.objectContaining({
          method: "PUT",
          path: USER_PATH,
          contentType: "application/json",
          body: {
            username: "Olive.R",
            email: "new@example.com",
            emailVerified: false,
            firstName: "",
            lastName: "",
          },
        }),
      ])
    })

    it("sends the whole profile with merged attributes", async () => {
      keycloak.respond(
        { status: 200, body: userRepresentation },
        { status: 204 },
      )

      await service.updateUser("user-1", {
        email: "new@example.com",
        lastName: undefined,
        attributes: { locale: ["fr"], usernameDisplay: ["Olive.R"] },
      })

      expect(
        keycloak.requests.map(({ method, body }) => ({ method, body })),
      ).toEqual([
        { method: "GET", body: undefined },
        {
          method: "PUT",
          body: {
            username: "olive.r",
            email: "new@example.com",
            firstName: "Olive",
            attributes: {
              birthdate: ["1990-05-06"],
              locale: ["fr"],
              usernameDisplay: ["Olive.R"],
            },
          },
        },
      ])
    })

    it("maps a 409 on the PUT after reading attributes", async () => {
      keycloak.respond({ status: 200, body: userRepresentation }, sameEmail)

      await expect(
        service.updateUser("user-1", {
          email: "taken@example.com",
          attributes: { locale: ["fr"] },
        }),
      ).rejects.toMatchObject({ field: "email" })
    })

    it("maps a 400 to KeycloakUserValidationError", async () => {
      keycloak.respond({
        status: 400,
        body: {
          field: "username",
          errorMessage: "error-user-attribute-read-only",
        },
      })

      const error = await service
        .updateUser("user-1", { username: "renamed" })
        .catch((e: unknown) => e)

      expect(error).toBeInstanceOf(KeycloakUserValidationError)
      expect(error).toMatchObject({
        field: "username",
        errorMessage: "error-user-attribute-read-only",
        status: 400,
      })
    })
  })

  describe("logoutUser", () => {
    it("ends the user's sessions", async () => {
      keycloak.respond({ status: 204 })

      await service.logoutUser("user-1")

      expect(keycloak.requests).toMatchObject([
        { method: "POST", path: `${USER_PATH}/logout` },
      ])
    })
  })

  describe("executeActionsEmail", () => {
    it("sends the actions with the link options", async () => {
      keycloak.respond({ status: 204 })

      await service.executeActionsEmail("user-1", ["VERIFY_EMAIL"], {
        clientId: "web",
        redirectUri: "https://app.example.com/me?verified=1&x=y",
        lifespan: 3600,
      })

      expect(keycloak.requests).toEqual([
        expect.objectContaining({
          method: "PUT",
          path: `${USER_PATH}/execute-actions-email`,
          query: {
            client_id: "web",
            redirect_uri: "https://app.example.com/me?verified=1&x=y",
            lifespan: "3600",
          },
          body: ["VERIFY_EMAIL"],
        }),
      ])
    })

    it("omits link options that are not given", async () => {
      keycloak.respond({ status: 204 })

      await service.executeActionsEmail("user-1", ["UPDATE_PASSWORD"])

      expect(keycloak.requests[0].query).toEqual({})
    })

    it("reports a user without email as a validation error", async () => {
      keycloak.respond({
        status: 400,
        body: { errorMessage: "User email missing" },
      })

      await expect(
        service.executeActionsEmail("user-1", ["VERIFY_EMAIL"]),
      ).rejects.toMatchObject({
        name: "KeycloakUserValidationError",
        errorMessage: "User email missing",
      })
    })
  })

  describe("listCredentials", () => {
    it("lists the credentials without their secrets", async () => {
      keycloak.respond({
        status: 200,
        body: [
          { id: "c1", type: "password", createdDate: 1, credentialData: "{}" },
          { id: "c2", type: "otp", userLabel: "phone", createdDate: 2 },
        ],
      })

      expect(await service.listCredentials("user-1")).toEqual([
        { id: "c1", type: "password", createdDate: 1 },
        { id: "c2", type: "otp", userLabel: "phone", createdDate: 2 },
      ])
      expect(keycloak.requests).toMatchObject([
        { method: "GET", path: `${USER_PATH}/credentials` },
      ])
    })
  })

  describe("deleteUser", () => {
    it("deletes the user", async () => {
      keycloak.respond({ status: 204 })

      await service.deleteUser("user-1")

      expect(keycloak.requests).toMatchObject([
        { method: "DELETE", path: USER_PATH },
      ])
    })
  })

  it("keeps an unrecognised 409 a request error", async () => {
    keycloak.respond({
      status: 409,
      body: { errorMessage: "User exists with same username or email" },
    })

    await expect(
      service.updateUser("user-1", { email: "a@b.c" }),
    ).rejects.toMatchObject({ name: "KeycloakAdminRequestError", status: 409 })
  })
})
