import { ModuleMetadata, Type } from "@nestjs/common"

export interface QueueModuleOptions {
  concurrency?: number
}

export interface QueueModuleAsyncOptions
  extends Pick<ModuleMetadata, "imports"> {
  useFactory?: (
    ...args: any[]
  ) => Promise<QueueModuleOptions> | QueueModuleOptions
  inject?: any[]
  useClass?: Type<QueueOptionsFactory>
  useExisting?: Type<QueueOptionsFactory>
}

export interface QueueOptionsFactory {
  createQueueOptions(): Promise<QueueModuleOptions> | QueueModuleOptions
}
