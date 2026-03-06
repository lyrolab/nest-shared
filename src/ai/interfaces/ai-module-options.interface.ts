import { ModuleMetadata, Type } from "@nestjs/common"

export interface AiModuleOptions {
  apiKey: string
  defaultModel?: string
  cacheTtlMs?: number
}

export interface AiModuleAsyncOptions extends Pick<ModuleMetadata, "imports"> {
  useFactory?: (...args: any[]) => Promise<AiModuleOptions> | AiModuleOptions
  inject?: any[]
  useClass?: Type<AiOptionsFactory>
  useExisting?: Type<AiOptionsFactory>
}

export interface AiOptionsFactory {
  createAiOptions(): Promise<AiModuleOptions> | AiModuleOptions
}
