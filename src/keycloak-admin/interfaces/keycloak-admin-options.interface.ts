import { ModuleMetadata } from "@nestjs/common"

export interface KeycloakAdminOptions {
  /** Keycloak base URL, e.g. `https://auth.example.com`. */
  url: string
  /** Realm holding both the service-account client and the managed users. */
  realm: string
  clientId: string
  clientSecret: string
  /** Per-request timeout. Defaults to 10 seconds. */
  timeoutMs?: number
}

export interface KeycloakAdminAsyncOptions
  extends Pick<ModuleMetadata, "imports"> {
  useFactory: (
    ...args: any[]
  ) => Promise<KeycloakAdminOptions> | KeycloakAdminOptions
  inject?: any[]
}
