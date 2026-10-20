import KeyvRedis from "@keyv/redis"
import { ConfigService } from "@nestjs/config"
import { DynamicModule, FactoryProvider } from "@nestjs/common"
import Keyv from "keyv"
import { RedisConfig } from "../redis/redis.config"
import { SharedCacheModule } from "./shared-cache.module"

type CacheOptions = {
  namespace?: string
  ttl?: number
  stores: KeyvRedis<unknown>[]
}

const buildCacheOptions = (env: Record<string, string>): CacheOptions => {
  const cacheModule = SharedCacheModule.forRoot().imports?.find(
    (imported): imported is DynamicModule =>
      typeof imported === "object" && "providers" in imported,
  )
  const factory = cacheModule?.providers?.find(
    (provider): provider is FactoryProvider =>
      typeof provider === "object" && "useFactory" in provider,
  )
  if (!factory) throw new Error("CacheModule options factory not found")

  return factory.useFactory(
    new ConfigService(env),
    new RedisConfig("redis://localhost:1", env.REDIS_KEY_PREFIX),
  ) as CacheOptions
}

describe("SharedCacheModule", () => {
  const optionsToClose: CacheOptions[] = []

  afterEach(async () => {
    await Promise.all(
      optionsToClose
        .splice(0)
        .flatMap((options) =>
          options.stores.map((store) => store.disconnect()),
        ),
    )
  })

  it("passes REDIS_KEY_PREFIX as the cache namespace", () => {
    const options = buildCacheOptions({ REDIS_KEY_PREFIX: "wk_test" })
    optionsToClose.push(options)

    expect(options.namespace).toBe("wk_test")
  })

  it("writes keys under the prefix through a Keyv built from the options", async () => {
    const options = buildCacheOptions({ REDIS_KEY_PREFIX: "wk_test" })
    optionsToClose.push(options)
    const store = new Map<string, unknown>()
    const keyv = new Keyv({
      store,
      ttl: options.ttl,
      namespace: options.namespace,
    })

    await keyv.set("ai:v2:openrouter/model:hash", { text: "cached" }, 60_000)

    expect([...store.keys()]).toEqual(["wk_test:ai:v2:openrouter/model:hash"])
  })

  it("leaves the namespace undefined without a prefix", () => {
    const options = buildCacheOptions({})
    optionsToClose.push(options)

    expect(options.namespace).toBeUndefined()
  })
})
