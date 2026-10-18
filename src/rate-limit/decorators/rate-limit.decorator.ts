import { applyDecorators, SetMetadata, UseGuards } from "@nestjs/common"
import { RateLimitGuard } from "../guards/rate-limit.guard"
import { RateLimitRule } from "../interfaces/rate-limit-options.interface"
import { RATE_LIMIT_RULES_KEY } from "../rate-limit.constants"

/**
 * Enforces the given limits on a route or controller. A string references a
 * limit registered in the module options; an object references one and
 * overrides some of its fields, or defines an unregistered limit inline (then
 * `limit` and `ttl` are required).
 *
 * Every limit is a bucket shared by all routes that use the same name.
 */
export const RateLimit = (
  ...rules: [RateLimitRule | string, ...(RateLimitRule | string)[]]
) =>
  applyDecorators(
    SetMetadata(
      RATE_LIMIT_RULES_KEY,
      rules.map((rule) => (typeof rule === "string" ? { name: rule } : rule)),
    ),
    UseGuards(RateLimitGuard),
  )
