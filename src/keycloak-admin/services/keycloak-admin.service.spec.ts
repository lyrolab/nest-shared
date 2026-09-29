import {
  KeycloakAdminAuthenticationError,
  KeycloakAdminRequestError,
  KeycloakUserNotFoundError,
} from "../errors/keycloak-admin.errors"
import { KeycloakAdminService } from "./keycloak-admin.service"

const TOKEN_URL =
  "https://kc.example.com/realms/acme/protocol/openid-connect/token"
const USER_URL = "https://kc.example.com/admin/realms/acme/users/user-1"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const token = (value: string, expiresIn = 300) =>
  json({ access_token: value, expires_in: expiresIn })

describe("KeycloakAdminService", () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>
  let service: KeycloakAdminService

  beforeEach(() => {
    fetchMock = jest.spyOn(global, "fetch")
    service = new KeycloakAdminService({
      url: "https://kc.example.com/",
      realm: "acme",
      clientId: "svc",
      clientSecret: "s3cret",
    })
  })

  afterEach(() => {
    fetchMock.mockRestore()
    jest.useRealTimers()
  })

  const calls = () =>
    (fetchMock.mock.calls as [string, RequestInit][]).map(([url, init]) => ({
      url,
      method: init.method,
      authorization: new Headers(init.headers).get("authorization"),
    }))

  it("fetches a client-credentials token and deletes the user with it", async () => {
    fetchMock
      .mockResolvedValueOnce(token("t1"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))

    await service.deleteUser("user-1")

    expect(calls()).toEqual([
      { url: TOKEN_URL, method: "POST", authorization: null },
      { url: USER_URL, method: "DELETE", authorization: "Bearer t1" },
    ])
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = init.body as URLSearchParams
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "client_credentials",
      client_id: "svc",
      client_secret: "s3cret",
    })
  })

  it("reuses the cached token until shortly before it expires", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] })
    fetchMock
      .mockResolvedValueOnce(token("t1", 300))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(token("t2", 300))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))

    await service.deleteUser("user-1")
    jest.advanceTimersByTime(260_000)
    await service.deleteUser("user-1")
    jest.advanceTimersByTime(20_000)
    await service.deleteUser("user-1")

    expect(calls().map((call) => call.authorization)).toEqual([
      null,
      "Bearer t1",
      "Bearer t1",
      null,
      "Bearer t2",
    ])
  })

  it("shares one token request between concurrent calls", async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === TOKEN_URL ? token("t1") : new Response(null, { status: 204 }),
      ),
    )

    await Promise.all([
      service.deleteUser("user-1"),
      service.deleteUser("user-1"),
    ])

    expect(calls().filter((call) => call.url === TOKEN_URL)).toHaveLength(1)
  })

  it("refreshes the token once when the admin API rejects it", async () => {
    fetchMock
      .mockResolvedValueOnce(token("revoked"))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(token("fresh"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))

    await service.deleteUser("user-1")

    expect(calls().map((call) => call.authorization)).toEqual([
      null,
      "Bearer revoked",
      null,
      "Bearer fresh",
    ])
  })

  it("gives up after a second rejected token", async () => {
    fetchMock
      .mockResolvedValueOnce(token("t1"))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(token("t2"))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))

    await expect(service.deleteUser("user-1")).rejects.toBeInstanceOf(
      KeycloakAdminAuthenticationError,
    )
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it("maps a 404 to KeycloakUserNotFoundError", async () => {
    fetchMock
      .mockResolvedValueOnce(token("t1"))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))

    const error = await service.deleteUser("user-1").catch((e: unknown) => e)

    expect(error).toBeInstanceOf(KeycloakUserNotFoundError)
    expect(error).toMatchObject({ userId: "user-1", status: 404 })
  })

  it("maps other failures to KeycloakAdminRequestError", async () => {
    fetchMock
      .mockResolvedValueOnce(token("t1"))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))

    await expect(service.deleteUser("user-1")).rejects.toMatchObject({
      name: "KeycloakAdminRequestError",
      status: 500,
    })
  })

  it("wraps network failures without leaking the secret", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"))

    const error = await service.deleteUser("user-1").catch((e: unknown) => e)

    expect(error).toBeInstanceOf(KeycloakAdminRequestError)
    expect(String((error as Error).message)).not.toContain("s3cret")
  })

  it("rejects a malformed token response", async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: "t1" }))

    await expect(service.deleteUser("user-1")).rejects.toBeInstanceOf(
      KeycloakAdminRequestError,
    )
  })

  it.each([" ", ".", ".."])(
    "rejects the user id %p without calling Keycloak",
    async (userId) => {
      await expect(service.deleteUser(userId)).rejects.toBeInstanceOf(
        KeycloakAdminRequestError,
      )
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it("encodes the user id into a single path segment", async () => {
    fetchMock
      .mockResolvedValueOnce(token("t1"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))

    await service.deleteUser("../roles/x")

    expect(calls()[1].url).toBe(
      "https://kc.example.com/admin/realms/acme/users/..%2Froles%2Fx",
    )
  })
})
