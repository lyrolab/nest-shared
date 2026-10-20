import { ModuleMetadata, Type } from "@nestjs/common"

export interface AiModuleOptions {
  apiKey: string
  defaultModel?: string
  defaultEmbeddingModel?: string
  /**
   * Cache TTL in milliseconds. Defaults to 24 hours; `0` disables the cache.
   */
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
