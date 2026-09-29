export interface JwtPayload {
  sub: string
  iss?: string
  email?: string
  preferred_username?: string
  given_name?: string
  family_name?: string
  realm_access?: { roles?: string[] }
  resource_access?: Record<string, { roles?: string[] } | undefined>
}

export interface AuthUser {
  id: string
  email?: string
  name?: string
  /** Verified `iss` of the token. Always set by `JwtStrategy`. */
  issuer?: string
  /** Realm roles plus the configured client's roles. Always set by `JwtStrategy`. */
  roles?: string[]
}
