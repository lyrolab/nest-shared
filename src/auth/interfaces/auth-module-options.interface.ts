import { ModuleMetadata, Type } from "@nestjs/common"

/**
 * Signing details for one trusted issuer, returned by {@link DynamicAuthOptions.resolveIssuer}.
 */
export interface ResolvedIssuer {
  jwksUri: string
  audience?: string | string[]
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
