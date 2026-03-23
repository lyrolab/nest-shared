import { RedisConfig } from "./redis.config"
import { SharedRedisModule } from "./shared-redis.module"

describe("SharedRedisModule", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, REDIS_URL: "redis://localhost:6379" }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe("forTest", () => {
    it("throws when REDIS_URL is not set", () => {
      delete process.env.REDIS_URL

      expect(() => SharedRedisModule.forTest()).toThrow(
        "REDIS_URL environment variable is required for test setup",
      )
    })

    it("uses VITEST_POOL_ID for key prefix", () => {
      process.env.VITEST_POOL_ID = "3"

      const { providers } = SharedRedisModule.forTest()
      const redisConfig = extractRedisConfig(providers)

      expect(redisConfig.keyPrefix).toBe("test_3")
    })

    it("falls back to JEST_WORKER_ID when VITEST_POOL_ID is not set", () => {
      delete process.env.VITEST_POOL_ID
      process.env.JEST_WORKER_ID = "5"

      const { providers } = SharedRedisModule.forTest()
      const redisConfig = extractRedisConfig(providers)

      expect(redisConfig.keyPrefix).toBe("test_5")
    })

    it("defaults to pool ID 0 when no worker env vars are set", () => {
      delete process.env.VITEST_POOL_ID
      delete process.env.JEST_WORKER_ID

      const { providers } = SharedRedisModule.forTest()
      const redisConfig = extractRedisConfig(providers)

      expect(redisConfig.keyPrefix).toBe("test_0")
    })

    it("provides RedisConfig with the correct URL", () => {
      const { providers } = SharedRedisModule.forTest()
      const redisConfig = extractRedisConfig(providers)

      expect(redisConfig.url).toBe("redis://localhost:6379")
    })

    it("is a global module", () => {
      const dynamicModule = SharedRedisModule.forTest()

      expect(dynamicModule.global).toBe(true)
    })
  })

  describe("forRoot", () => {
    it("does not set a key prefix", () => {
      const dynamicModule = SharedRedisModule.forRoot()

      expect(dynamicModule.module).toBe(SharedRedisModule)
      expect(dynamicModule.global).toBe(true)
    })
  })
})

function extractRedisConfig(providers: unknown[] | undefined): RedisConfig {
  const provider = providers?.find(
    (p): p is { provide: typeof RedisConfig; useValue: RedisConfig } =>
      typeof p === "object" &&
      p !== null &&
      "useValue" in p &&
      p.useValue instanceof RedisConfig,
  )
  if (!provider) throw new Error("RedisConfig provider not found")
  return provider.useValue
}
