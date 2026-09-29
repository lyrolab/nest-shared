import { Injectable } from "@nestjs/common"
import { KeycloakUserNotFoundError } from "../errors/keycloak-admin.errors"
import { KeycloakAdminService } from "./keycloak-admin.service"

/**
 * In-memory stand-in for {@link KeycloakAdminService}, provided by
 * `KeycloakAdminModule.forTest()`. Every user exists until deleted once.
 */
@Injectable()
export class KeycloakAdminStubService
  implements Pick<KeycloakAdminService, "deleteUser">
{
  readonly deletedUserIds: string[] = []

  deleteUser(userId: string): Promise<void> {
    if (this.deletedUserIds.includes(userId)) {
      return Promise.reject(new KeycloakUserNotFoundError(userId))
    }
    this.deletedUserIds.push(userId)
    return Promise.resolve()
  }
}
