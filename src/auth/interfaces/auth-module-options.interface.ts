import { ModuleMetadata, Type } from "@nestjs/common"

export interface AuthModuleOptions {
  jwksUri: string
  issuer: string
}

export interface AuthModuleAsyncOptions
  extends Pick<ModuleMetadata, "imports"> {
  useFactory?: (
    ...args: any[]
  ) => Promise<AuthModuleOptions> | AuthModuleOptions
  inject?: any[]
  useClass?: Type<AuthOptionsFactory>
  useExisting?: Type<AuthOptionsFactory>
}

export interface AuthOptionsFactory {
  createAuthOptions(): Promise<AuthModuleOptions> | AuthModuleOptions
}
