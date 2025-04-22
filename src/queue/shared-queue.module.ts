import { BullModule } from "@nestjs/bullmq"
import { DynamicModule, Module, Provider } from "@nestjs/common"
import { DiscoveryModule } from "@nestjs/core"
import { QueueController } from "./controllers/queue.controller"
import {
  QueueModuleAsyncOptions,
  QueueModuleOptions,
  QueueOptionsFactory,
} from "./interfaces/queue-options.interface"
import { QueueProcessor } from "./processors/queue.processor"
import { DEFAULT_QUEUE, QUEUE_MODULE_OPTIONS } from "./queue.constants"
import { QueueService } from "./services/queue.service"

@Module({})
export class SharedQueueModule {
  static forRoot(options: QueueModuleOptions = {}): DynamicModule {
    return {
      module: SharedQueueModule,
      global: true,
      imports: [
        BullModule.registerQueue({ name: DEFAULT_QUEUE }),
        DiscoveryModule,
      ],
      providers: [
        {
          provide: QUEUE_MODULE_OPTIONS,
          useValue: options,
        },
        QueueService,
        QueueProcessor,
      ],
      exports: [QueueService],
      controllers: [QueueController],
    }
  }

  static forRootAsync(options: QueueModuleAsyncOptions): DynamicModule {
    return {
      module: SharedQueueModule,
      global: true,
      imports: [
        BullModule.registerQueue({ name: DEFAULT_QUEUE }),
        DiscoveryModule,
        ...(options.imports || []),
      ],
      providers: [
        ...this.createAsyncProviders(options),
        QueueService,
        QueueProcessor,
      ],
      exports: [QueueService],
      controllers: [QueueController],
    }
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
