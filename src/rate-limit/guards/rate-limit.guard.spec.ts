import {
  Controller,
  ExecutionContext,
  Get,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { ThrottlerException, ThrottlerStorage } from "@nestjs/throttler"
import { RateLimit } from "../decorators/rate-limit.decorator"
import { RateLimitModuleOptions } from "../interfaces/rate-limit-options.interface"
import { RateLimitGuard } from "./rate-limit.guard"

@Controller()
class TestController {
  @RateLimit("writes")
  registered() {}

  @RateLimit({ name: "writes", limit: 1 })
  overridden() {}

  @RateLimit({ name: "inline", limit: 2, ttl: 1_000, key: "ip" })
  inline() {}

  @RateLimit("writes", { name: "writes-ip", limit: 3, ttl: 1_000, key: "ip" })
  stacked() {}

  @RateLimit("unknown")
  unknown() {}

  @Get()
  unlimited() {}
}

class FakeStorage implements ThrottlerStorage {
  readonly hits = new Map<string, number>()
  readonly calls: Array<{ key: string; name: string; limit: number }> = []
  failure: Error | null = null

  increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    name: string,
  ) {
    if (this.failure) return Promise.reject(this.failure)
    this.calls.push({ key, name, limit })
    const bucket = `${name}:${key}`
    const totalHits = (this.hits.get(bucket) ?? 0) + 1
    this.hits.set(bucket, totalHits)
    const isBlocked = totalHits > limit
    return Promise.resolve({
      totalHits,
      timeToExpire: ttl / 1000,
      isBlocked,
      timeToBlockExpire: isBlocked ? blockDuration / 1000 : 0,
    })
  }
}

describe("RateLimitGuard", () => {
  let storage: FakeStorage
  let headers: Record<string, unknown>

  const createGuard = (options: Partial<RateLimitModuleOptions> = {}) =>
    new RateLimitGuard(
      new Reflector(),
      { limits: { writes: { limit: 2, ttl: 60_000 } }, ...options },
      storage,
    )

  const contextFor = (
    handler: keyof TestController,
    request: Record<string, unknown> = {},
  ) =>
    ({
      getHandler: () => TestController.prototype[handler],
      getClass: () => TestController,
      switchToHttp: () => ({
        getRequest: () => ({ headers: {}, ip: "1.2.3.4", ...request }),
        getResponse: () => ({
          setHeader: (name: string, value: unknown) => {
            headers[name] = value
          },
        }),
      }),
    }) as unknown as ExecutionContext

  beforeEach(() => {
    storage = new FakeStorage()
    headers = {}
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => jest.restoreAllMocks())

  it("ignores routes without @RateLimit", async () => {
    await expect(
      createGuard().canActivate(contextFor("unlimited")),
    ).resolves.toBe(true)
    expect(storage.calls).toHaveLength(0)
  })

  it("throws a 429 with Retry-After once the registered limit is exceeded", async () => {
    const guard = createGuard()
    await guard.canActivate(contextFor("registered"))
    await guard.canActivate(contextFor("registered"))

    await expect(
      guard.canActivate(contextFor("registered")),
    ).rejects.toBeInstanceOf(ThrottlerException)
    expect(headers["Retry-After"]).toBe(60)
  })

  it("applies per-route overrides on top of the registered limit", async () => {
    const guard = createGuard()
    await guard.canActivate(contextFor("overridden"))

    await expect(
      guard.canActivate(contextFor("overridden")),
    ).rejects.toBeInstanceOf(ThrottlerException)
  })

  it("enforces an inline limit that is not registered", async () => {
    const guard = createGuard()
    await guard.canActivate(contextFor("inline"))

    expect(storage.calls).toEqual([
      expect.objectContaining({ name: "inline", limit: 2 }),
    ])
  })

  it("enforces every stacked limit", async () => {
    await createGuard().canActivate(contextFor("stacked"))

    expect(storage.calls.map((call) => call.name)).toEqual([
      "writes",
      "writes-ip",
    ])
  })

  it("rejects a route referencing an unknown limit without limit and ttl", async () => {
    await expect(
      createGuard().canActivate(contextFor("unknown")),
    ).rejects.toThrow('Rate limit "unknown" is not registered')
  })

  describe("tracker", () => {
    const keyFor = async (
      handler: keyof TestController,
      request: Record<string, unknown>,
      options: Partial<RateLimitModuleOptions> = {},
    ) => {
      storage = new FakeStorage()
      await createGuard(options).canActivate(contextFor(handler, request))
      return storage.calls[0].key
    }

    it("keys identity limits on the authenticated user", async () => {
      const user = { id: "sub-1", issuer: "https://idp" }

      expect(await keyFor("registered", { user, ip: "1.1.1.1" })).toBe(
        await keyFor("registered", { user, ip: "2.2.2.2" }),
      )
    })

    it("separates the same subject from different issuers", async () => {
      expect(
        await keyFor("registered", {
          user: { id: "sub-1", issuer: "https://a" },
        }),
      ).not.toBe(
        await keyFor("registered", {
          user: { id: "sub-1", issuer: "https://b" },
        }),
      )
    })

    it("prefers the identify hook over the authenticated user", async () => {
      const identify = () => "end-user:42"

      expect(
        await keyFor("registered", { user: { id: "a" } }, { identify }),
      ).toBe(await keyFor("registered", { user: { id: "b" } }, { identify }))
    })

    it("falls back to the client IP for anonymous callers", async () => {
      expect(await keyFor("registered", { ip: "1.1.1.1" })).not.toBe(
        await keyFor("registered", { ip: "2.2.2.2" }),
      )
    })

    it("keys ip limits on the IP even for authenticated callers", async () => {
      expect(await keyFor("inline", { user: { id: "a" }, ip: "1.1.1.1" })).toBe(
        await keyFor("inline", { user: { id: "b" }, ip: "1.1.1.1" }),
      )
    })

    it("reads the client IP from the configured header", async () => {
      const options = { clientIpHeader: "cf-connecting-ip" }

      expect(
        await keyFor(
          "inline",
          { headers: { "cf-connecting-ip": "9.9.9.9" }, ip: "1.1.1.1" },
          options,
        ),
      ).toBe(
        await keyFor(
          "inline",
          { headers: { "cf-connecting-ip": "9.9.9.9" }, ip: "2.2.2.2" },
          options,
        ),
      )
    })
  })

  describe("storage failure", () => {
    beforeEach(() => {
      storage.failure = new Error("Connection is closed.")
    })

    it("allows the request by default", async () => {
      await expect(
        createGuard().canActivate(contextFor("registered")),
      ).resolves.toBe(true)
    })

    it("answers 503 when configured to deny", async () => {
      await expect(
        createGuard({ onStorageError: "deny" }).canActivate(
          contextFor("registered"),
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException)
    })
  })
})
