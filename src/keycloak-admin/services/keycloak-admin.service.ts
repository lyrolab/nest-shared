import { Inject, Injectable } from "@nestjs/common"
import {
  KeycloakAdminAuthenticationError,
  KeycloakAdminError,
  KeycloakAdminForbiddenError,
  KeycloakAdminRequestError,
  KeycloakUserConflictError,
  KeycloakUserConflictField,
  KeycloakUserNotFoundError,
  KeycloakUserValidationError,
} from "../errors/keycloak-admin.errors"
import { KeycloakAdminOptions } from "../interfaces/keycloak-admin-options.interface"
import {
  ExecuteActionsEmailOptions,
  KeycloakCredential,
  KeycloakUser,
  KeycloakUserPatch,
} from "../interfaces/keycloak-user.interface"
import { KEYCLOAK_ADMIN_OPTIONS } from "../keycloak-admin.constants"

const DEFAULT_TIMEOUT_MS = 10_000
const TOKEN_EXPIRY_MARGIN_MS = 30_000

interface CachedToken {
  value: string
  expiresAt: number
}

interface AdminRequest {
  query?: Record<string, string | number | undefined>
  body?: unknown
}

interface KeycloakErrorBody {
  field?: unknown
  errorMessage?: unknown
  error?: unknown
}

@Injectable()
export class KeycloakAdminService {
  private token: CachedToken | null = null
  private pendingToken: Promise<CachedToken> | null = null
  private readonly baseUrl: string
  private readonly realm: string
  private readonly timeoutMs: number

  constructor(
    @Inject(KEYCLOAK_ADMIN_OPTIONS)
    private readonly options: KeycloakAdminOptions,
  ) {
    this.baseUrl = options.url.replace(/\/+$/, "")
    this.realm = encodeURIComponent(options.realm)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Reads the user whose Keycloak id (the token `sub`) is `userId`. */
  async getUser(userId: string): Promise<KeycloakUser> {
    const response = await this.userRequest("GET", userId, "")
    await this.assertUserOk(response, userId, "read user")
    return toKeycloakUser(await this.readJson(response, "read user"))
  }

  /**
   * Changes the given fields of a user. Keycloak keeps `emailVerified` when the
   * email changes, so pass `emailVerified: false` to have the new address verified.
   */
  async updateUser(userId: string, patch: KeycloakUserPatch): Promise<void> {
    const { attributes, ...fields } = patch
    const changes = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    )
    let body: Record<string, unknown> = changes
    // A body with `attributes` is taken as the whole profile: Keycloak clears the
    // username, email, names and attributes it leaves out.
    if (attributes) {
      const current = await this.getUser(userId)
      body = {
        username: current.username,
        email: current.email,
        firstName: current.firstName,
        lastName: current.lastName,
        ...changes,
        attributes: { ...current.attributes, ...attributes },
      }
    }
    const response = await this.userRequest("PUT", userId, "", { body })
    await this.assertUserOk(response, userId, "update user")
  }

  /** Ends every session of the user. */
  async logoutUser(userId: string): Promise<void> {
    const response = await this.userRequest("POST", userId, "/logout")
    await this.assertUserOk(response, userId, "log out user")
  }

  /**
   * Emails the user a link that runs the given required actions, e.g.
   * `["VERIFY_EMAIL"]` or `["UPDATE_PASSWORD"]`.
   */
  async executeActionsEmail(
    userId: string,
    actions: string[],
    options: ExecuteActionsEmailOptions = {},
  ): Promise<void> {
    const response = await this.userRequest(
      "PUT",
      userId,
      "/execute-actions-email",
      {
        query: {
          client_id: options.clientId,
          redirect_uri: options.redirectUri,
          lifespan: options.lifespan,
        },
        body: actions,
      },
    )
    await this.assertUserOk(response, userId, "send actions email")
  }

  /** Lists the user's credentials (`password`, `otp`, …) without their secrets. */
  async listCredentials(userId: string): Promise<KeycloakCredential[]> {
    const response = await this.userRequest("GET", userId, "/credentials")
    await this.assertUserOk(response, userId, "list credentials")
    const body = await this.readJson(response, "list credentials")
    if (!Array.isArray(body)) {
      throw new KeycloakAdminRequestError(
        "Keycloak credentials response is malformed",
      )
    }
    return body.map(toKeycloakCredential)
  }

  /** Deletes the user whose Keycloak id (the token `sub`) is `userId`. */
  async deleteUser(userId: string): Promise<void> {
    const response = await this.userRequest("DELETE", userId, "")
    await this.assertUserOk(response, userId, "delete user")
  }

  private userRequest(
    method: string,
    userId: string,
    subPath: string,
    request: AdminRequest = {},
  ): Promise<Response> {
    return this.adminRequest(
      method,
      `/users/${encodeURIComponent(this.requireUserId(userId))}${subPath}`,
      request,
    )
  }

  private async assertUserOk(
    response: Response,
    userId: string,
    action: string,
  ): Promise<void> {
    if (response.status === 404) throw new KeycloakUserNotFoundError(userId)
    if (response.status === 409) {
      const body = await readErrorBody(response)
      const field = conflictField(body)
      if (field) throw new KeycloakUserConflictError(userId, field)
      throw new KeycloakAdminRequestError(
        `Keycloak failed to ${action}: HTTP 409`,
        409,
      )
    }
    if (response.status === 400) {
      const body = await readErrorBody(response)
      throw new KeycloakUserValidationError(
        userId,
        typeof body.field === "string" ? body.field : undefined,
        errorMessageOf(body),
      )
    }
    this.assertOk(response, action)
  }

  private async readJson(response: Response, action: string): Promise<unknown> {
    try {
      return await response.json()
    } catch (error) {
      throw new KeycloakAdminRequestError(
        `Keycloak response to ${action} is not JSON`,
        response.status,
        { cause: error },
      )
    }
  }

  // "." and ".." survive encodeURIComponent and would be normalized away by URL
  // parsing, retargeting the request at the realm itself.
  private requireUserId(userId: string): string {
    if (
      typeof userId !== "string" ||
      userId.trim() === "" ||
      userId === "." ||
      userId === ".."
    ) {
      throw new KeycloakAdminRequestError("Invalid Keycloak user id")
    }
    return userId
  }

  private async adminRequest(
    method: string,
    path: string,
    { query, body }: AdminRequest = {},
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl}/admin/realms/${this.realm}${path}`)
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value))
    }
    const send = async () =>
      this.fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${(await this.getToken()).value}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })

    const response = await send()
    // A cached token can be revoked or its session ended before its expiry.
    if (response.status === 401) {
      this.token = null
      return send()
    }
    return response
  }

  private assertOk(response: Response, action: string): void {
    if (response.ok) return
    if (response.status === 401) {
      throw new KeycloakAdminAuthenticationError(
        `Keycloak rejected the admin token (${action})`,
        response.status,
      )
    }
    if (response.status === 403) {
      throw new KeycloakAdminForbiddenError(
        `Keycloak service account may not ${action}`,
        response.status,
      )
    }
    throw new KeycloakAdminRequestError(
      `Keycloak failed to ${action}: HTTP ${response.status}`,
      response.status,
    )
  }

  private async getToken(): Promise<CachedToken> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token

    this.pendingToken ??= this.requestToken().finally(() => {
      this.pendingToken = null
    })
    this.token = await this.pendingToken
    return this.token
  }

  private async requestToken(): Promise<CachedToken> {
    const response = await this.fetch(
      `${this.baseUrl}/realms/${this.realm}/protocol/openid-connect/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
        }),
      },
    )

    if (response.status === 400 || response.status === 401) {
      throw new KeycloakAdminAuthenticationError(
        "Keycloak rejected the admin client credentials",
        response.status,
      )
    }
    if (!response.ok) {
      throw new KeycloakAdminRequestError(
        `Keycloak token request failed: HTTP ${response.status}`,
        response.status,
      )
    }

    const body = (await response.json()) as {
      access_token?: unknown
      expires_in?: unknown
    }
    if (
      typeof body.access_token !== "string" ||
      typeof body.expires_in !== "number"
    ) {
      throw new KeycloakAdminRequestError(
        "Keycloak token response is malformed",
      )
    }

    const lifetimeMs = body.expires_in * 1000
    const margin = Math.min(TOKEN_EXPIRY_MARGIN_MS, lifetimeMs / 2)
    return {
      value: body.access_token,
      expiresAt: Date.now() + lifetimeMs - margin,
    }
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      if (error instanceof KeycloakAdminError) throw error
      throw new KeycloakAdminRequestError(
        "Keycloak request failed",
        undefined,
        {
          cause: error,
        },
      )
    }
  }
}

async function readErrorBody(response: Response): Promise<KeycloakErrorBody> {
  try {
    const body: unknown = await response.json()
    return typeof body === "object" && body !== null
      ? (body as KeycloakErrorBody)
      : {}
  } catch {
    return {}
  }
}

function errorMessageOf(body: KeycloakErrorBody): string | undefined {
  if (typeof body.errorMessage === "string") return body.errorMessage
  if (typeof body.error === "string") return body.error
  return undefined
}

// Keycloak answers "User exists with same username" or "... same email".
function conflictField(
  body: KeycloakErrorBody,
): KeycloakUserConflictField | undefined {
  if (body.field === "username" || body.field === "email") return body.field
  const message = errorMessageOf(body)?.toLowerCase() ?? ""
  const username = message.includes("username")
  const email = message.includes("email")
  if (username && !email) return "username"
  if (email && !username) return "email"
  return undefined
}

function toKeycloakUser(value: unknown): KeycloakUser {
  const user = (value ?? {}) as Record<string, unknown>
  if (typeof user.id !== "string" || typeof user.username !== "string") {
    throw new KeycloakAdminRequestError("Keycloak user response is malformed")
  }
  return {
    id: user.id,
    username: user.username,
    email: optionalString(user.email),
    emailVerified: user.emailVerified === true,
    firstName: optionalString(user.firstName),
    lastName: optionalString(user.lastName),
    enabled: user.enabled !== false,
    createdTimestamp:
      typeof user.createdTimestamp === "number"
        ? user.createdTimestamp
        : undefined,
    attributes: toAttributes(user.attributes),
    requiredActions: Array.isArray(user.requiredActions)
      ? user.requiredActions.filter(
          (action): action is string => typeof action === "string",
        )
      : [],
  }
}

function toAttributes(value: unknown): Record<string, string[]> {
  if (typeof value !== "object" || value === null) return {}
  return Object.fromEntries(
    Object.entries(value).map(([name, values]) => [
      name,
      Array.isArray(values)
        ? values.filter((item): item is string => typeof item === "string")
        : [],
    ]),
  )
}

function toKeycloakCredential(value: unknown): KeycloakCredential {
  const credential = (value ?? {}) as Record<string, unknown>
  if (
    typeof credential.id !== "string" ||
    typeof credential.type !== "string"
  ) {
    throw new KeycloakAdminRequestError(
      "Keycloak credentials response is malformed",
    )
  }
  return {
    id: credential.id,
    type: credential.type,
    userLabel: optionalString(credential.userLabel),
    createdDate:
      typeof credential.createdDate === "number"
        ? credential.createdDate
        : undefined,
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}
