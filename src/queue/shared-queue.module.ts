import { BullModule, getQueueToken } from "@nestjs/bullmq"
import { DynamicModule, Module, Provider } from "@nestjs/common"
import { DiscoveryModule } from "@nestjs/core"
import { Queue } from "bullmq"
import { QueueController } from "./controllers/queue.controller"
import {
  QueueDefinition,
  QueueModuleAsyncOptions,
  QueueModuleOptions,
  QueueOptionsFactory,
} from "./interfaces/queue-options.interface"
import { createQueueProcessor } from "./processors/queue-processor.factory"
import { QueueProcessor } from "./processors/queue.processor"
import {
  DEFAULT_QUEUE,
  QUEUE_DEFINITIONS,
  QUEUE_MAP,
  QUEUE_MODULE_OPTIONS,
} from "./queue.constants"
import { JobRegistryService } from "./services/job-registry.service"
import { QueueService } from "./services/queue.service"

@Module({})
export class SharedQueueModule {
  static forRoot(options: QueueModuleOptions = {}): DynamicModule {
    const queueDefinitions = this.validateQueueDefinitions(options.queues)
    const queueNames = this.queueNames(queueDefinitions)

    return {
      module: SharedQueueModule,
      global: true,
      imports: [
        BullModule.registerQueue(
          ...queueNames.map((name) => ({
            name,
            ...(options.telemetry && { telemetry: options.telemetry }),
          })),
        ),
        DiscoveryModule,
      ],
      providers: [
        {
          provide: QUEUE_MODULE_OPTIONS,
          useValue: options,
        },
        ...this.createCommonProviders(queueDefinitions),
      ],
      exports: [QueueService],
      controllers: [QueueController],
    }
  }

  static forRootAsync(options: QueueModuleAsyncOptions): DynamicModule {
    const queueDefinitions = this.validateQueueDefinitions(options.queues)
    const queueNames = this.queueNames(queueDefinitions)

    return {
      module: SharedQueueModule,
      global: true,
      imports: [
        BullModule.registerQueueAsync(
          ...queueNames.map((name) => ({
            name,
            useFactory: (moduleOptions?: QueueModuleOptions) => ({
              ...(moduleOptions?.telemetry && {
                telemetry: moduleOptions.telemetry,
              }),
            }),
            inject: [QUEUE_MODULE_OPTIONS],
          })),
        ),
        DiscoveryModule,
        ...(options.imports || []),
      ],
      providers: [
        ...this.createAsyncProviders(options),
        ...this.createCommonProviders(queueDefinitions),
      ],
      exports: [QueueService, QUEUE_MODULE_OPTIONS],
      controllers: [QueueController],
    }
  }

  private static validateQueueDefinitions(
    queues: QueueDefinition[] = [],
  ): QueueDefinition[] {
    if (queues.some((queue) => queue.name === DEFAULT_QUEUE)) {
      throw new Error(
        `Queue name "${DEFAULT_QUEUE}" is reserved for the default queue. Use the module-level "concurrency" option instead.`,
      )
    }

    const names = queues.map((queue) => queue.name)
    const duplicates = names.filter((name, i) => names.indexOf(name) !== i)
    if (duplicates.length > 0) {
      throw new Error(`Duplicate queue definitions: ${duplicates.join(", ")}`)
    }

    return queues
  }

  private static queueNames(queueDefinitions: QueueDefinition[]): string[] {
    return [DEFAULT_QUEUE, ...queueDefinitions.map((queue) => queue.name)]
  }

  private static createCommonProviders(
    queueDefinitions: QueueDefinition[],
  ): Provider[] {
    const queueNames = this.queueNames(queueDefinitions)

    return [
      {
        provide: QUEUE_DEFINITIONS,
        useValue: queueDefinitions,
      },
      {
        provide: QUEUE_MAP,
        useFactory: (...queues: Queue[]) =>
          new Map(queueNames.map((name, i) => [name, queues[i]])),
        inject: queueNames.map((name) => getQueueToken(name)),
      },
      JobRegistryService,
      QueueService,
      QueueProcessor,
      ...queueDefinitions.map((definition) => createQueueProcessor(definition)),
    ]
  }

  private static createAsyncProviders(
    options: QueueModuleAsyncOptions,
  ): Provider[] {
    if (options.useExisting || options.useFactory) {
      return [this.createAsyncOptionsProvider(options)]
    }

    return [
      this.createAsyncOptionsProvider(options),
      {
        provide: options.useClass!,
        useClass: options.useClass!,
      },
    ]
  }

  private static createAsyncOptionsProvider(
    options: QueueModuleAsyncOptions,
  ): Provider {
    if (options.useFactory) {
      return {
        provide: QUEUE_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject || [],
      }
    }

    return {
      provide: QUEUE_MODULE_OPTIONS,
      useFactory: async (optionsFactory: QueueOptionsFactory) => {
        return optionsFactory.createQueueOptions()
      },
      inject: [options.useExisting || options.useClass!],
    }
  }
}
