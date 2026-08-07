import { BullModule, getQueueToken } from "@nestjs/bullmq"
import { DynamicModule, Module, Provider } from "@nestjs/common"
import { DiscoveryModule } from "@nestjs/core"
import { Queue } from "bullmq"
import { QueueController } from "./controllers/queue.controller"
import {
  QueueDefinition,
  QueueModuleAsyncOptions,
  QueueModuleFactoryOptions,
  QueueModuleOptions,
  QueueOptionsFactory,
} from "./interfaces/queue-options.interface"
import { createQueueProcessor } from "./processors/queue-processor.factory"
import {
  DEFAULT_QUEUE,
  QUEUE_MAP,
  QUEUE_MODULE_OPTIONS,
} from "./queue.constants"
import { JobRegistryService } from "./services/job-registry.service"
import { QueueService } from "./services/queue.service"

type ModuleConfig = {
  registerQueues: (queueNames: string[]) => DynamicModule
  optionsProviders: Provider[]
  imports?: DynamicModule["imports"]
  exports: DynamicModule["exports"]
}

@Module({})
export class SharedQueueModule {
  static forRoot(options: QueueModuleOptions = {}): DynamicModule {
    return this.buildModule(options.queues, {
      registerQueues: (queueNames) =>
        BullModule.registerQueue(
          ...queueNames.map((name) => ({
            name,
            telemetry: options.telemetry,
          })),
        ),
      optionsProviders: [{ provide: QUEUE_MODULE_OPTIONS, useValue: options }],
      exports: [QueueService],
    })
  }

  static forRootAsync(options: QueueModuleAsyncOptions): DynamicModule {
    return this.buildModule(options.queues, {
      registerQueues: (queueNames) =>
        BullModule.registerQueueAsync(
          ...queueNames.map((name) => ({
            name,
            useFactory: (moduleOptions?: QueueModuleFactoryOptions) => ({
              telemetry: moduleOptions?.telemetry,
            }),
            inject: [QUEUE_MODULE_OPTIONS],
          })),
        ),
      optionsProviders: this.createAsyncProviders(options),
      imports: options.imports,
      // QUEUE_MODULE_OPTIONS is exported so the registerQueueAsync factories
      // (child modules of BullModule) can inject it from the global scope.
      exports: [QueueService, QUEUE_MODULE_OPTIONS],
    })
  }

  private static buildModule(
    queues: QueueDefinition[] | undefined,
    config: ModuleConfig,
  ): DynamicModule {
    const allDefinitions = [
      { name: DEFAULT_QUEUE },
      ...this.validateQueueDefinitions(queues),
    ]
    const queueNames = allDefinitions.map((definition) => definition.name)

    return {
      module: SharedQueueModule,
      global: true,
      imports: [
        config.registerQueues(queueNames),
        DiscoveryModule,
        ...(config.imports ?? []),
      ],
      providers: [
        ...config.optionsProviders,
        {
          provide: QUEUE_MAP,
          useFactory: (...queues: Queue[]) =>
            new Map(queueNames.map((name, i) => [name, queues[i]])),
          inject: queueNames.map((name) => getQueueToken(name)),
        },
        JobRegistryService,
        QueueService,
        ...allDefinitions.map((definition) => createQueueProcessor(definition)),
      ],
      exports: config.exports,
      controllers: [QueueController],
    }
  }

  private static validateQueueDefinitions(
    queues: QueueDefinition[] = [],
  ): QueueDefinition[] {
    const seen = new Set<string>()
    for (const { name } of queues) {
      if (name === DEFAULT_QUEUE) {
        throw new Error(
          `Queue name "${DEFAULT_QUEUE}" is reserved for the default queue. Use the module-level "concurrency" option instead.`,
        )
      }
      if (seen.has(name)) {
        throw new Error(`Duplicate queue definition: ${name}`)
      }
      seen.add(name)
    }
    return queues
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
