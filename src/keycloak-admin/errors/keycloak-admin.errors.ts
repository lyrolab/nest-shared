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

/** Any other failure: unexpected status, network error or timeout. */
export class KeycloakAdminRequestError extends KeycloakAdminError {}
