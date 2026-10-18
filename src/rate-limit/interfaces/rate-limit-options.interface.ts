import { ModuleMetadata } from "@nestjs/common"
import type { ThrottlerStorage } from "@nestjs/throttler"
import { Request } from "express"

export type RateLimitRecord = Awaited<ReturnType<ThrottlerStorage["increment"]>>

export type RateLimitKey = "identity" | "ip"

export interface RateLimitDefinition {
  /** Requests allowed per window. */
  limit: number
  /** Window length in milliseconds. */
  ttl: number
  /** How long a tracker stays blocked once over the limit, in milliseconds. Defaults to `ttl`. */
  blockDuration?: number
  /** What the limit is counted against. Defaults to `"identity"`. */
  key?: RateLimitKey
}

export interface RateLimitRule extends Partial<RateLimitDefinition> {
  name: string
}

export interface RateLimitModuleOptions {
  /** Named limits that routes reference through `@RateLimit()`. */
  limits?: Record<string, RateLimitDefinition>
  /**
   * Resolves the caller's identity for `key: "identity"` limits. Returning
   * nothing falls back to the authenticated `request.user`, then to the client IP.
   */
  identify?: (request: Request) => string | null | undefined
  /**
   * Header carrying the real client IP, set by a proxy that overwrites it
   * (e.g. `cf-connecting-ip` behind Cloudflare). Falls back to `request.ip`.
   */
  clientIpHeader?: string
  /** Behaviour when the Redis storage fails. Defaults to `"allow"`. */
  onStorageError?: "allow" | "deny"
}

export interface RateLimitModuleAsyncOptions
  extends Pick<ModuleMetadata, "imports"> {
  useFactory: (
    ...args: any[]
  ) => Promise<RateLimitModuleOptions> | RateLimitModuleOptions
  inject?: any[]
}
