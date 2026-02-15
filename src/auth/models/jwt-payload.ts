export interface JwtPayload {
  sub: string
  email?: string
  preferred_username?: string
  given_name?: string
  family_name?: string
  realm_access?: { roles: string[] }
}

export interface AuthUser {
  id: string
  email?: string
  name?: string
}
