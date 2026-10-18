export interface JwtPayload {
  sub: string
  iss?: string
  email?: string
  preferred_username?: string
  given_name?: string
  family_name?: string
  realm_access?: { roles?: string[] }
  resource_access?: Record<string, { roles?: string[] } | undefined>
  groups?: string[]
}

export interface AuthUser {
  id: string
  email?: string
  name?: string
  /** Verified `iss` of the token. Always set by `JwtStrategy`. */
  issuer?: string
  /** Realm roles plus the configured client's roles. Always set by `JwtStrategy`. */
  roles?: string[]
  /**
   * Verified `realm_access.roles`, `resource_access[*].roles` and `groups` claims,
   * read regardless of `trustRoles`. Unlike `roles`, they are never used for
   * `@Roles()` checks; the app decides whether the issuer is trusted for them.
   */
  realmRoles?: string[]
  clientRoles?: Record<string, string[]>
  groups?: string[]
}
