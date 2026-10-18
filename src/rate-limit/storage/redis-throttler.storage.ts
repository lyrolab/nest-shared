import { Logger, OnApplicationShutdown, OnModuleInit } from "@nestjs/common"
import type { ThrottlerStorage } from "@nestjs/throttler"
import Redis from "ioredis"
import { RateLimitRecord } from "../interfaces/rate-limit-options.interface"

// Fixed window counter plus a separate block key, so a blocked tracker stays
// blocked for the whole block duration even after its window rolls over.
const INCREMENT_SCRIPT = `
local hitsKey = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local block = tonumber(ARGV[3])

local blockTtl = redis.call('PTTL', blockKey)
if blockTtl > 0 then
  local hits = tonumber(redis.call('GET', hitsKey) or '0')
  return {hits, math.max(redis.call('PTTL', hitsKey), 0), 1, blockTtl}
end

local hits = redis.call('INCR', hitsKey)
if hits == 1 then
  redis.call('PEXPIRE', hitsKey, ttl)
end
local hitsTtl = redis.call('PTTL', hitsKey)
if hitsTtl < 0 then
  redis.call('PEXPIRE', hitsKey, ttl)
  hitsTtl = ttl
end

if hits > limit then
  if block <= 0 then
    block = hitsTtl
  end
  redis.call('SET', blockKey, '1', 'PX', block)
  return {hits, hitsTtl, 1, block}
end

return {hits, hitsTtl, 0, 0}
`

type IncrementReply = [number, number, 0 | 1, number]

type ScriptedRedis = Redis & {
  rateLimitIncrement(
    hitsKey: string,
    blockKey: string,
    ttl: number,
    limit: number,
    blockDuration: number,
  ): Promise<IncrementReply>
}

/**
 * `ThrottlerStorage` shared by every replica through Redis. Usable on its own
 * as the `storage` of a plain `ThrottlerModule`.
 */
export class RedisThrottlerStorage
  implements ThrottlerStorage, OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(RedisThrottlerStorage.name)
  private readonly client: ScriptedRedis
  private lastConnectionErrorAt = 0

  constructor(url: string, keyPrefix?: string) {
    // Fail fast instead of queueing commands while Redis reconnects: a request
    // must never hang on its rate limit check.
    this.client = new Redis(url, {
      keyPrefix: keyPrefix ? `${keyPrefix}:` : undefined,
      commandTimeout: 250,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    }) as ScriptedRedis
    this.client.defineCommand("rateLimitIncrement", {
      numberOfKeys: 2,
      lua: INCREMENT_SCRIPT,
    })
    this.client.on("error", (error: Error) => {
      if (Date.now() - this.lastConnectionErrorAt < 60_000) return
      this.lastConnectionErrorAt = Date.now()
      this.logger.warn(`Rate limit Redis connection error: ${error.message}`)
    })
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect().catch((error: Error) => {
      this.logger.warn(
        `Rate limit Redis unavailable at startup: ${error.message}`,
      )
    })
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<RateLimitRecord> {
    const base = `rl:${throttlerName}:${key}`
    const [totalHits, timeToExpire, isBlocked, timeToBlockExpire] =
      await this.client.rateLimitIncrement(
        `${base}:hits`,
        `${base}:block`,
        ttl,
        limit,
        blockDuration,
      )
    return {
      totalHits,
      timeToExpire: Math.ceil(timeToExpire / 1000),
      isBlocked: isBlocked === 1,
      timeToBlockExpire: Math.ceil(timeToBlockExpire / 1000),
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect())
  }
}
