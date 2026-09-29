import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  mixin,
  Optional,
  Type,
  UnauthorizedException,
} from "@nestjs/common"
import type { Cache } from "cache-manager"
import { Request } from "express"
import {
  ProvisioningIdentity,
  UserProvisioner,
  UserProvisioningGuardOptions,
} from "../interfaces/user-provisioner.interface"
import { AuthUser } from "../models/jwt-payload"

// Same value as @nestjs/cache-manager's CACHE_MANAGER, inlined so importing the
// auth module never requires the cache package at runtime.
const CACHE_MANAGER = "CACHE_MANAGER"

const DEFAULT_REQUEST_PROPERTY = "dbUser"

export function provisioningCacheKey(issuer: string, subject: string): string {
  return `auth:provisioning:${JSON.stringify([issuer, subject])}`
}

/**
 * Builds a guard that resolves the authenticated caller to a local user through
 * the app's {@link UserProvisioner} and writes it to `request[requestProperty]`.
 *
 * Register it after `JwtAuthGuard`: it trusts `request.user`, which only the
 * verified JWT strategy sets. Requests without `request.user` (public routes) pass
 * through untouched.
 */
export function createUserProvisioningGuard(
  options: UserProvisioningGuardOptions,
): Type<CanActivate> {
  const requestProperty = options.requestProperty ?? DEFAULT_REQUEST_PROPERTY

  @Injectable()
  class UserProvisioningGuard implements CanActivate {
    constructor(
      @Inject(options.provisioner)
      private readonly provisioner: UserProvisioner,
      @Optional() @Inject(CACHE_MANAGER) private readonly cache?: Cache,
    ) {
      if (options.cacheTtlMs !== undefined && !this.cache) {
        throw new Error(
          "createUserProvisioningGuard: cacheTtlMs requires CACHE_MANAGER to be provided",
        )
      }
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
      const request = context
        .switchToHttp()
        .getRequest<Request & { user?: AuthUser } & Record<string, unknown>>()
      const user = request.user
      if (!user) return true

      const identity = toIdentity(user)
      const provisioned = await this.provisionCached(identity)
      if (provisioned === null || provisioned === undefined) {
        throw new UnauthorizedException()
      }

      request[requestProperty] = provisioned
      return true
    }

    private async provisionCached(
      identity: ProvisioningIdentity,
    ): Promise<unknown> {
      if (options.cacheTtlMs === undefined || !this.cache) {
        return this.provisioner.provision(identity)
      }

      const key = provisioningCacheKey(identity.issuer, identity.subject)
      const cached = await this.cache.get<unknown>(key)
      if (cached !== undefined && cached !== null) return cached

      const provisioned = await this.provisioner.provision(identity)
      if (provisioned !== undefined && provisioned !== null) {
        await this.cache.set(key, provisioned, options.cacheTtlMs)
      }
      return provisioned
    }
  }

  return mixin(UserProvisioningGuard)
}

function toIdentity(user: AuthUser): ProvisioningIdentity {
  if (!user.issuer || !user.id) {
    throw new UnauthorizedException()
  }
  return {
    issuer: user.issuer,
    subject: user.id,
    email: user.email,
    name: user.name,
    roles: user.roles ?? [],
  }
}
