export interface KeycloakUser {
  id: string
  username: string
  email?: string
  emailVerified: boolean
  firstName?: string
  lastName?: string
  enabled: boolean
  createdTimestamp?: number
  attributes: Record<string, string[]>
  requiredActions: string[]
}

/**
 * Fields to change on a user; omitted fields keep their value. `attributes` is
 * merged into the user's attributes key by key, and an empty list removes one.
 */
export interface KeycloakUserPatch {
  username?: string
  email?: string
  emailVerified?: boolean
  firstName?: string
  lastName?: string
  attributes?: Record<string, string[]>
}

export interface KeycloakCredential {
  id: string
  type: string
  userLabel?: string
  createdDate?: number
}

export interface ExecuteActionsEmailOptions {
  /** Client the link returns to after the actions. */
  clientId?: string
  /** Where the link returns to; must be a valid redirect URI of `clientId`. */
  redirectUri?: string
  /** Link lifetime in seconds. */
  lifespan?: number
}
