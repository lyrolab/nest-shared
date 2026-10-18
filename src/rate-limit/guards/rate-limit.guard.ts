import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { ThrottlerException, type ThrottlerStorage } from "@nestjs/throttler"
import { createHash } from "crypto"
import { Request, Response } from "express"
import { clientIp } from "../helpers/client-ip"
import {
  RateLimitDefinition,
  RateLimitModuleOptions,
  RateLimitRecord,
  RateLimitRule,
} from "../interfaces/rate-limit-options.interface"
import {
  RATE_LIMIT_MODULE_OPTIONS,
  RATE_LIMIT_RULES_KEY,
  RATE_LIMIT_STORAGE,
} from "../rate-limit.constants"

type ResolvedRule = Required<RateLimitDefinition> & { name: string }

interface AuthenticatedRequest extends Request {
  user?: { id?: string; issuer?: string }
}

/**
 * Enforces the limits a route declares with `@RateLimit()`. Attached at method
 * or controller level by the decorator, so it runs after global and
 * controller guards and can key on identities they resolve.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name)
  private lastStorageErrorAt = 0

  constructor(
    private readonly reflector: Reflector,
    @Inject(RATE_LIMIT_MODULE_OPTIONS)
    private readonly options: RateLimitModuleOptions,
    @Inject(RATE_LIMIT_STORAGE) private readonly storage: ThrottlerStorage,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rules = this.reflector.getAllAndOverride<RateLimitRule[] | undefined>(
      RATE_LIMIT_RULES_KEY,
      [context.getHandler(), context.getClass()],
    )
    if (!rules?.length) return true

    const http = context.switchToHttp()
    const request = http.getRequest<AuthenticatedRequest>()
    const response = http.getResponse<Response>()

    for (const rule of rules.map((rule) => this.resolve(rule))) {
      const record = await this.increment(rule, this.tracker(request, rule))
      if (record?.isBlocked) {
        response.setHeader("Retry-After", Math.max(record.timeToBlockExpire, 1))
        throw new ThrottlerException()
      }
    }
    return true
  }

  private resolve(rule: RateLimitRule): ResolvedRule {
    const merged = { ...this.options.limits?.[rule.name], ...rule }
    if (merged.limit === undefined || merged.ttl === undefined) {
      throw new Error(
        `Rate limit "${rule.name}" is not registered and does not define limit and ttl`,
      )
    }
    return {
      name: rule.name,
      limit: merged.limit,
      ttl: merged.ttl,
      blockDuration: merged.blockDuration ?? merged.ttl,
      key: merged.key ?? "identity",
    }
  }

  private tracker(request: AuthenticatedRequest, rule: ResolvedRule): string {
    const ip = `ip:${clientIp(request, this.options.clientIpHeader)}`
    if (rule.key === "ip") return ip

    const identity = this.options.identify?.(request)
    if (identity) return identity
    if (request.user?.id) {
      return `user:${request.user.issuer ?? ""}:${request.user.id}`
    }
    return ip
  }

  private async increment(
    rule: ResolvedRule,
    tracker: string,
  ): Promise<RateLimitRecord | null> {
    const key = createHash("sha256").update(tracker).digest("hex").slice(0, 32)
    try {
      return await this.storage.increment(
        key,
        rule.ttl,
        rule.limit,
        rule.blockDuration,
        rule.name,
      )
    } catch (error) {
      this.logStorageError(error)
      if (this.options.onStorageError === "deny") {
        throw new ServiceUnavailableException()
      }
      return null
    }
  }

  private logStorageError(error: unknown) {
    if (Date.now() - this.lastStorageErrorAt < 60_000) return
    this.lastStorageErrorAt = Date.now()
    const message = error instanceof Error ? error.message : String(error)
    this.logger.warn(`Rate limit storage unavailable: ${message}`)
  }
}
