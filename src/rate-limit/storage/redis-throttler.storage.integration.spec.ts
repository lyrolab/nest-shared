import { Logger } from "@nestjs/common"
import Redis from "ioredis"
import { GenericContainer, StartedTestContainer } from "testcontainers"
import { RedisThrottlerStorage } from "./redis-throttler.storage"

jest.setTimeout(120_000)

describe("RedisThrottlerStorage (integration)", () => {
  let container: StartedTestContainer
  let url: string
  let storage: RedisThrottlerStorage
  let other: RedisThrottlerStorage

  beforeAll(async () => {
    container = await new GenericContainer("redis:7")
      .withExposedPorts(6379)
      .start()
    url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`
    storage = new RedisThrottlerStorage(url, "it")
    other = new RedisThrottlerStorage(url, "it")
    await storage.onModuleInit()
    await other.onModuleInit()
  })

  beforeEach(() => {
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
  })

  afterAll(async () => {
    await storage.onApplicationShutdown()
    await other.onApplicationShutdown()
    await container.stop()
  })

  const key = () => Math.random().toString(36).slice(2)

  it("counts hits and reports the remaining window", async () => {
    const tracker = key()

    const first = await storage.increment(tracker, 60_000, 2, 60_000, "a")
    const second = await storage.increment(tracker, 60_000, 2, 60_000, "a")

    expect(first).toEqual({
      totalHits: 1,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0,
    })
    expect(second.totalHits).toBe(2)
    expect(second.isBlocked).toBe(false)
  })

  it("shares counters across instances, as replicas do", async () => {
    const tracker = key()

    await storage.increment(tracker, 60_000, 1, 30_000, "a")
    const blocked = await other.increment(tracker, 60_000, 1, 30_000, "a")

    expect(blocked.isBlocked).toBe(true)
    expect(blocked.timeToBlockExpire).toBe(30)
  })

  it("keeps a blocked tracker blocked for the block duration after the window ends", async () => {
    const tracker = key()

    await storage.increment(tracker, 200, 1, 1_500, "a")
    await storage.increment(tracker, 200, 1, 1_500, "a")
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(
      (await storage.increment(tracker, 200, 1, 1_500, "a")).isBlocked,
    ).toBe(true)
  })

  it("starts a fresh window once the previous one expires", async () => {
    const tracker = key()

    await storage.increment(tracker, 200, 1, 200, "a")
    await storage.increment(tracker, 200, 1, 200, "a")
    await new Promise((resolve) => setTimeout(resolve, 450))

    expect(await storage.increment(tracker, 200, 1, 200, "a")).toMatchObject({
      totalHits: 1,
      isBlocked: false,
    })
  })

  it("keeps separate buckets per limit name", async () => {
    const tracker = key()

    await storage.increment(tracker, 60_000, 1, 60_000, "a")

    expect(
      (await storage.increment(tracker, 60_000, 1, 60_000, "b")).isBlocked,
    ).toBe(false)
  })

  it("writes keys under the configured prefix with an expiry", async () => {
    const tracker = key()
    const redis = new Redis(url)

    await storage.increment(tracker, 60_000, 5, 60_000, "a")

    expect(await redis.pttl(`it:rl:a:${tracker}:hits`)).toBeGreaterThan(0)
    await redis.quit()
  })

  it("rejects instead of hanging when Redis is unreachable", async () => {
    const unreachable = new RedisThrottlerStorage("redis://127.0.0.1:1")
    await unreachable.onModuleInit()

    await expect(
      unreachable.increment(key(), 60_000, 1, 60_000, "a"),
    ).rejects.toThrow()
    await unreachable.onApplicationShutdown()
  })
})
