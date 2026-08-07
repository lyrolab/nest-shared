import { ModuleMetadata, Type } from "@nestjs/common"
import { Telemetry } from "bullmq"

export interface QueueDefinition {
  name: string
  concurrency?: number
}

export interface QueueModuleOptions {
  /**
   * Worker concurrency for the default queue.
   */
  concurrency?: number

  /**
   * Additional named queues, each with its own worker and concurrency.
   */
  queues?: QueueDefinition[]

  /**
   * BullMQ-native telemetry (e.g. BullMQOtel), threaded into every queue and
   * worker the module creates.
   */
  telemetry?: Telemetry
}

export interface QueueModuleAsyncOptions
  extends Pick<ModuleMetadata, "imports"> {
  /**
   * Static because BullMQ queue registration happens at module-definition
   * time, before any async factory can run.
   */
  queues?: QueueDefinition[]
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
