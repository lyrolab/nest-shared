import { Inject, Injectable } from "@nestjs/common"
import {
  KeycloakAdminAuthenticationError,
  KeycloakAdminError,
  KeycloakAdminForbiddenError,
  KeycloakAdminRequestError,
  KeycloakUserNotFoundError,
} from "../errors/keycloak-admin.errors"
import { KeycloakAdminOptions } from "../interfaces/keycloak-admin-options.interface"
import { KEYCLOAK_ADMIN_OPTIONS } from "../keycloak-admin.constants"

const DEFAULT_TIMEOUT_MS = 10_000
const TOKEN_EXPIRY_MARGIN_MS = 30_000

interface CachedToken {
  value: string
  expiresAt: number
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

  /** Deletes the user whose Keycloak id (the token `sub`) is `userId`. */
  async deleteUser(userId: string): Promise<void> {
    const response = await this.adminRequest(
      "DELETE",
      `/users/${encodeURIComponent(this.requireUserId(userId))}`,
    )
    if (response.status === 404) throw new KeycloakUserNotFoundError(userId)
    this.assertOk(response, "delete user")
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

  private async adminRequest(method: string, path: string): Promise<Response> {
    const url = `${this.baseUrl}/admin/realms/${this.realm}${path}`
    const send = async () =>
      this.fetch(url, {
        method,
        headers: { Authorization: `Bearer ${(await this.getToken()).value}` },
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
