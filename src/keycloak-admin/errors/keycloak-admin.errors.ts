export class KeycloakAdminError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = new.target.name
  }
}

/** The token endpoint rejected the client credentials. */
export class KeycloakAdminAuthenticationError extends KeycloakAdminError {}

/** The service account lacks the role required for the operation. */
export class KeycloakAdminForbiddenError extends KeycloakAdminError {}

export class KeycloakUserNotFoundError extends KeycloakAdminError {
  constructor(readonly userId: string) {
    super(`Keycloak user ${userId} not found`, 404)
  }
}

export type KeycloakUserConflictField = "username" | "email"

/** Another user already has the username or email (HTTP 409). */
export class KeycloakUserConflictError extends KeycloakAdminError {
  constructor(
    readonly userId: string,
    readonly field: KeycloakUserConflictField,
  ) {
    super(`Another Keycloak user has the same ${field}`, 409)
  }
}

/** Keycloak's user profile rejected a value (HTTP 400). */
export class KeycloakUserValidationError extends KeycloakAdminError {
  constructor(
    readonly userId: string,
    readonly field: string | undefined,
    readonly errorMessage: string | undefined,
  ) {
    super(
      `Keycloak rejected the user${field ? ` ${field}` : ""}: ${errorMessage ?? "invalid value"}`,
      400,
    )
  }
}

/** Any other failure: unexpected status, network error or timeout. */
export class KeycloakAdminRequestError extends KeycloakAdminError {}
