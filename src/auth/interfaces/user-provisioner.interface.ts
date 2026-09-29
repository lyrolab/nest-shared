import { InjectionToken } from "@nestjs/common"

/**
 * Verified identity of the caller. `(issuer, subject)` is the user key: the same
 * `subject` from two issuers is two different users.
 */
export interface ProvisioningIdentity {
  issuer: string
  subject: string
  email?: string
  name?: string
  roles: string[]
}

/**
 * App-provided lookup that returns the local user for an identity, creating it on
 * first sight. Throwing (e.g. `UnauthorizedException`) rejects the request.
 */
export interface UserProvisioner<TUser = unknown> {
  provision(identity: ProvisioningIdentity): Promise<TUser>
}

export interface UserProvisioningGuardOptions {
  /** Provider (class or token) implementing {@link UserProvisioner}. */
  provisioner: InjectionToken
  /** Request property the provisioned user is written to. Defaults to `dbUser`. */
  requestProperty?: string
  /** Caches provisioned users in `CACHE_MANAGER` for this many milliseconds. */
  cacheTtlMs?: number
}
