import { ModuleMetadata, Type } from "@nestjs/common"

/**
 * Signing details for one trusted issuer, returned by {@link DynamicAuthOptions.resolveIssuer}.
 */
export interface ResolvedIssuer {
  jwksUri: string
  audience?: string | string[]
  /**
   * Copies the token's `realm_access` and `resource_access[clientId]` roles onto
   * `AuthUser.roles`. Off by default: an issuer that is trusted to authenticate is
   * not automatically trusted to grant application roles.
   */
  trustRoles?: boolean
  /** Client whose `resource_access` roles are read when `trustRoles` is set. */
  clientId?: string
}

/**
 * Single-issuer validation: every token must carry `issuer` and be signed by a key
 * from `jwksUri`.
 */
export interface StaticAuthOptions {
  jwksUri: string
  issuer: string
  audience?: string | string[]
  algorithms?: string[]
  /** Client whose `resource_access` roles are added to the realm roles. */
  clientId?: string
}

/**
 * Multi-issuer validation: the token's `iss` is resolved to its signing config at
 * request time. Returning `null` marks the issuer untrusted, which rejects the token.
 */
export interface DynamicAuthOptions {
  resolveIssuer: (
    iss: string,
  ) => Promise<ResolvedIssuer | null> | ResolvedIssuer | null
  algorithms?: string[]
}

export type AuthModuleOptions = StaticAuthOptions | DynamicAuthOptions

export function isDynamicAuthOptions(
  options: AuthModuleOptions,
): options is DynamicAuthOptions {
  return typeof (options as DynamicAuthOptions).resolveIssuer === "function"
}

export interface AuthModuleAsyncOptions
  extends Pick<ModuleMetadata, "imports"> {
  useFactory?: (
    ...args: any[]
  ) => Promise<AuthModuleOptions> | AuthModuleOptions
  inject?: any[]
  useClass?: Type<AuthOptionsFactory>
  useExisting?: Type<AuthOptionsFactory>
}

export interface AuthOptionsFactory {
  createAuthOptions(): Promise<AuthModuleOptions> | AuthModuleOptions
}
