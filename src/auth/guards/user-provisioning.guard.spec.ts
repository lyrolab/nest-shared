import { ExecutionContext, UnauthorizedException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { UserProvisioner } from "../interfaces/user-provisioner.interface"
import { AuthUser } from "../models/jwt-payload"
import {
  createUserProvisioningGuard,
  provisioningCacheKey,
} from "./user-provisioning.guard"

const ISS_A = "https://idp-a.example.com/realms/acme"
const ISS_B = "https://idp-b.example.com/realms/globex"
const PROVISIONER = Symbol("PROVISIONER")

interface LocalUser {
  id: string
  issuer: string
  subject: string
}

class InMemoryProvisioner implements UserProvisioner<LocalUser> {
  readonly users = new Map<string, LocalUser>()

  provision = jest.fn(
    ({ issuer, subject }: { issuer: string; subject: string }) => {
      const key = JSON.stringify([issuer, subject])
      let user = this.users.get(key)
      if (!user) {
        user = { id: `local-${this.users.size + 1}`, issuer, subject }
        this.users.set(key, user)
      }
      return Promise.resolve(user)
    },
  )
}

type TestRequest = { user?: AuthUser } & Record<string, unknown>

const contextFor = (request: TestRequest): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext

const userFrom = (issuer: string, id = "same-sub"): AuthUser => ({
  id,
  issuer,
  email: "u@example.com",
  name: "u",
  roles: ["user"],
})

class MapCache {
  readonly store = new Map<string, unknown>()
  get = jest.fn((key: string) => Promise.resolve(this.store.get(key)))
  set = jest.fn((key: string, value: unknown) => {
    this.store.set(key, value)
    return Promise.resolve(value)
  })
}

async function buildGuard(
  options: { requestProperty?: string; cacheTtlMs?: number } = {},
  cache?: MapCache,
) {
  const provisioner = new InMemoryProvisioner()
  const Guard = createUserProvisioningGuard({
    provisioner: PROVISIONER,
    ...options,
  })
  const moduleRef = await Test.createTestingModule({
    providers: [
      Guard,
      { provide: PROVISIONER, useValue: provisioner },
      ...(cache ? [{ provide: "CACHE_MANAGER", useValue: cache }] : []),
    ],
  }).compile()
  return { guard: moduleRef.get(Guard), provisioner }
}

describe("createUserProvisioningGuard", () => {
  it("passes requests without an authenticated user through untouched", async () => {
    const { guard, provisioner } = await buildGuard()
    const request: TestRequest = {}

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true)
    expect(provisioner.provision).not.toHaveBeenCalled()
    expect(request.dbUser).toBeUndefined()
  })

  it("provisions the user and writes it to request.dbUser", async () => {
    const { guard, provisioner } = await buildGuard()
    const request: TestRequest = { user: userFrom(ISS_A) }

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true)
    expect(provisioner.provision).toHaveBeenCalledWith({
      issuer: ISS_A,
      subject: "same-sub",
      email: "u@example.com",
      name: "u",
      roles: ["user"],
    })
    expect(request.dbUser).toEqual({
      id: "local-1",
      issuer: ISS_A,
      subject: "same-sub",
    })
  })

  it("keeps two issuers with the same subject as two users", async () => {
    const { guard } = await buildGuard()
    const fromA: TestRequest = { user: userFrom(ISS_A) }
    const fromB: TestRequest = { user: userFrom(ISS_B) }
    const fromAAgain: TestRequest = { user: userFrom(ISS_A) }

    await guard.canActivate(contextFor(fromA))
    await guard.canActivate(contextFor(fromB))
    await guard.canActivate(contextFor(fromAAgain))

    expect(fromA.dbUser).not.toEqual(fromB.dbUser)
    expect(fromAAgain.dbUser).toEqual(fromA.dbUser)
  })

  it("writes to a custom request property", async () => {
    const { guard } = await buildGuard({ requestProperty: "localUser" })
    const request: TestRequest = { user: userFrom(ISS_A) }

    await guard.canActivate(contextFor(request))

    expect(request.localUser).toMatchObject({ id: "local-1" })
    expect(request.dbUser).toBeUndefined()
  })

  it("rejects a user without a verified issuer", async () => {
    const { guard, provisioner } = await buildGuard()
    const request: TestRequest = { user: { id: "same-sub" } }

    await expect(guard.canActivate(contextFor(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    expect(provisioner.provision).not.toHaveBeenCalled()
  })

  it("rejects a user without a subject", async () => {
    const { guard, provisioner } = await buildGuard()
    const request: TestRequest = { user: userFrom(ISS_A, "") }

    await expect(guard.canActivate(contextFor(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    expect(provisioner.provision).not.toHaveBeenCalled()
  })

  it("rejects when the provisioner returns nothing", async () => {
    const { guard, provisioner } = await buildGuard()
    provisioner.provision.mockResolvedValueOnce(
      undefined as unknown as LocalUser,
    )

    await expect(
      guard.canActivate(contextFor({ user: userFrom(ISS_A) })),
    ).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it("propagates a provisioner rejection", async () => {
    const { guard, provisioner } = await buildGuard()
    provisioner.provision.mockRejectedValueOnce(new UnauthorizedException("no"))

    await expect(
      guard.canActivate(contextFor({ user: userFrom(ISS_A) })),
    ).rejects.toBeInstanceOf(UnauthorizedException)
  })

  describe("with caching", () => {
    it("serves repeat requests from the cache", async () => {
      const cache = new MapCache()
      const { guard, provisioner } = await buildGuard(
        { cacheTtlMs: 30_000 },
        cache,
      )

      const first: TestRequest = { user: userFrom(ISS_A) }
      const second: TestRequest = { user: userFrom(ISS_A) }
      await guard.canActivate(contextFor(first))
      await guard.canActivate(contextFor(second))

      expect(provisioner.provision).toHaveBeenCalledTimes(1)
      expect(second.dbUser).toEqual(first.dbUser)
      expect(cache.set).toHaveBeenCalledWith(
        provisioningCacheKey(ISS_A, "same-sub"),
        first.dbUser,
        30_000,
      )
    })

    it("never serves one issuer's cached user to another issuer with the same subject", async () => {
      const cache = new MapCache()
      const { guard, provisioner } = await buildGuard(
        { cacheTtlMs: 30_000 },
        cache,
      )

      const fromA: TestRequest = { user: userFrom(ISS_A) }
      const fromB: TestRequest = { user: userFrom(ISS_B) }
      await guard.canActivate(contextFor(fromA))
      await guard.canActivate(contextFor(fromB))

      expect(provisioner.provision).toHaveBeenCalledTimes(2)
      expect(fromB.dbUser).not.toEqual(fromA.dbUser)
    })

    it("builds unambiguous keys when issuer or subject contain separators", () => {
      expect(provisioningCacheKey("https://a:b", "c")).not.toBe(
        provisioningCacheKey("https://a", "b:c"),
      )
    })

    it("fails fast when CACHE_MANAGER is missing", async () => {
      await expect(buildGuard({ cacheTtlMs: 30_000 })).rejects.toThrow(
        /CACHE_MANAGER/,
      )
    })
  })
})
