import { Injectable } from "@nestjs/common"
import {
  KeycloakUserConflictError,
  KeycloakUserNotFoundError,
  KeycloakUserValidationError,
} from "../errors/keycloak-admin.errors"
import {
  ExecuteActionsEmailOptions,
  KeycloakCredential,
  KeycloakUser,
  KeycloakUserPatch,
} from "../interfaces/keycloak-user.interface"
import { KeycloakAdminService } from "./keycloak-admin.service"

export type KeycloakAdminStubCall =
  | { operation: "getUser"; userId: string }
  | { operation: "updateUser"; userId: string; patch: KeycloakUserPatch }
  | { operation: "logoutUser"; userId: string }
  | {
      operation: "executeActionsEmail"
      userId: string
      actions: string[]
      options: ExecuteActionsEmailOptions
    }
  | { operation: "listCredentials"; userId: string }
  | { operation: "deleteUser"; userId: string }

export type KeycloakStubUserSeed = Partial<Omit<KeycloakUser, "id">> & {
  id: string
  credentials?: KeycloakCredential[]
}

type KeycloakAdminOperations = Pick<
  KeycloakAdminService,
  | "getUser"
  | "updateUser"
  | "logoutUser"
  | "executeActionsEmail"
  | "listCredentials"
  | "deleteUser"
>

/**
 * In-memory stand-in for {@link KeycloakAdminService}, provided by
 * `KeycloakAdminModule.forTest()`. Every user exists until deleted once; a user
 * never seeded reads as `{ id, username: id }` with no email and no credentials.
 */
@Injectable()
export class KeycloakAdminStubService implements KeycloakAdminOperations {
  readonly calls: KeycloakAdminStubCall[] = []
  readonly deletedUserIds: string[] = []
  private readonly users = new Map<string, KeycloakUser>()
  private readonly credentials = new Map<string, KeycloakCredential[]>()

  /** Adds or replaces a user, as Keycloak stores it. */
  seedUser({ credentials, ...seed }: KeycloakStubUserSeed): KeycloakUser {
    const user: KeycloakUser = {
      ...this.defaultUser(seed.id),
      ...structuredClone(seed),
    }
    user.username = user.username.toLowerCase()
    user.email = user.email?.toLowerCase()
    this.users.set(user.id, user)
    if (credentials) this.credentials.set(user.id, structuredClone(credentials))
    return structuredClone(user)
  }

  getUser(userId: string): Promise<KeycloakUser> {
    this.calls.push({ operation: "getUser", userId })
    return this.run(() => structuredClone(this.existingUser(userId)))
  }

  updateUser(userId: string, patch: KeycloakUserPatch): Promise<void> {
    this.calls.push({
      operation: "updateUser",
      userId,
      patch: structuredClone(patch),
    })
    return this.run(() => {
      const user = this.existingUser(userId)
      const username = patch.username?.toLowerCase()
      const email = patch.email?.toLowerCase()
      if (username !== undefined && username.trim() === "") {
        throw new KeycloakUserValidationError(
          userId,
          "username",
          "error-user-attribute-required",
        )
      }
      if (
        username !== undefined &&
        this.isTaken("username", username, userId)
      ) {
        throw new KeycloakUserConflictError(userId, "username")
      }
      if (email && this.isTaken("email", email, userId)) {
        throw new KeycloakUserConflictError(userId, "email")
      }
      const { attributes, ...fields } = structuredClone(patch)
      for (const [name, value] of Object.entries(fields)) {
        if (value !== undefined) Object.assign(user, { [name]: value })
      }
      if (username !== undefined) user.username = username
      if (email !== undefined) user.email = email
      if (attributes) {
        for (const [name, values] of Object.entries(attributes)) {
          if (values.length === 0) delete user.attributes[name]
          else user.attributes[name] = values
        }
      }
    })
  }

  logoutUser(userId: string): Promise<void> {
    this.calls.push({ operation: "logoutUser", userId })
    return this.run(() => {
      this.existingUser(userId)
    })
  }

  executeActionsEmail(
    userId: string,
    actions: string[],
    options: ExecuteActionsEmailOptions = {},
  ): Promise<void> {
    this.calls.push({
      operation: "executeActionsEmail",
      userId,
      actions: [...actions],
      options: { ...options },
    })
    return this.run(() => {
      if (!this.existingUser(userId).email) {
        throw new KeycloakUserValidationError(
          userId,
          undefined,
          "User email missing",
        )
      }
    })
  }

  listCredentials(userId: string): Promise<KeycloakCredential[]> {
    this.calls.push({ operation: "listCredentials", userId })
    return this.run(() => {
      this.existingUser(userId)
      return structuredClone(this.credentials.get(userId) ?? [])
    })
  }

  deleteUser(userId: string): Promise<void> {
    this.calls.push({ operation: "deleteUser", userId })
    return this.run(() => {
      this.existingUser(userId)
      this.deletedUserIds.push(userId)
      this.users.delete(userId)
      this.credentials.delete(userId)
    })
  }

  private run<T>(operation: () => T): Promise<T> {
    try {
      return Promise.resolve(operation())
    } catch (error) {
      return Promise.reject(error as Error)
    }
  }

  private existingUser(userId: string): KeycloakUser {
    if (this.deletedUserIds.includes(userId)) {
      throw new KeycloakUserNotFoundError(userId)
    }
    let user = this.users.get(userId)
    if (!user) {
      user = this.defaultUser(userId)
      this.users.set(userId, user)
    }
    return user
  }

  private isTaken(
    field: "username" | "email",
    value: string,
    exceptUserId: string,
  ): boolean {
    return [...this.users.values()].some(
      (user) => user.id !== exceptUserId && user[field] === value,
    )
  }

  private defaultUser(userId: string): KeycloakUser {
    return {
      id: userId,
      username: userId.toLowerCase(),
      emailVerified: false,
      enabled: true,
      attributes: {},
      requiredActions: [],
    }
  }
}
