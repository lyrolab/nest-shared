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

/**
 * Options resolvable through an async factory. `queues` is excluded: BullMQ
 * queue registration happens at module-definition time, so the queue list is a
 * static property of `QueueModuleAsyncOptions` instead.
 */
export type QueueModuleFactoryOptions = Omit<QueueModuleOptions, "queues">

export interface QueueModuleAsyncOptions
  extends Pick<ModuleMetadata, "imports"> {
  queues?: QueueDefinition[]
  useFactory?: (
    ...args: any[]
  ) => Promise<QueueModuleFactoryOptions> | QueueModuleFactoryOptions
  inject?: any[]
  useClass?: Type<QueueOptionsFactory>
  useExisting?: Type<QueueOptionsFactory>
}

export interface QueueOptionsFactory {
  createQueueOptions():
    | Promise<QueueModuleFactoryOptions>
    | QueueModuleFactoryOptions
}
