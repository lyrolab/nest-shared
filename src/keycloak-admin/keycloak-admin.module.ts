import { DynamicModule, Module } from "@nestjs/common"
import { KeycloakAdminAsyncOptions } from "./interfaces/keycloak-admin-options.interface"
import { KEYCLOAK_ADMIN_OPTIONS } from "./keycloak-admin.constants"
import { KeycloakAdminStubService } from "./services/keycloak-admin-stub.service"
import { KeycloakAdminService } from "./services/keycloak-admin.service"

@Module({})
export class KeycloakAdminModule {
  static forRootAsync(options: KeycloakAdminAsyncOptions): DynamicModule {
    return {
      module: KeycloakAdminModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: KEYCLOAK_ADMIN_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        KeycloakAdminService,
      ],
      exports: [KeycloakAdminService],
    }
  }

  static forTest(): DynamicModule {
    return {
      module: KeycloakAdminModule,
      providers: [
        KeycloakAdminStubService,
        {
          provide: KeycloakAdminService,
          useExisting: KeycloakAdminStubService,
        },
      ],
      exports: [KeycloakAdminService, KeycloakAdminStubService],
    }
  }
}
