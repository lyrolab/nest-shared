import { DynamicModule, Module, Provider } from "@nestjs/common"
import { SharedCacheModule } from "../cache"
import { AI_MODULE_OPTIONS } from "./ai.constants"
import {
  AiModuleAsyncOptions,
  AiModuleOptions,
  AiOptionsFactory,
} from "./interfaces/ai-module-options.interface"
import { AiService } from "./services/ai.service"

@Module({})
export class SharedAiModule {
  static forRoot(options: AiModuleOptions): DynamicModule {
    return {
      module: SharedAiModule,
      global: false,
      imports: [SharedCacheModule.forRoot()],
      providers: [
        {
          provide: AI_MODULE_OPTIONS,
          useValue: options,
        },
        AiService,
      ],
      exports: [AiService],
    }
  }

  static forRootAsync(options: AiModuleAsyncOptions): DynamicModule {
    return {
      module: SharedAiModule,
      global: false,
      imports: [SharedCacheModule.forRoot(), ...(options.imports || [])],
      providers: [...this.createAsyncProviders(options), AiService],
      exports: [AiService],
    }
  }

  private static createAsyncProviders(
    options: AiModuleAsyncOptions,
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
    options: AiModuleAsyncOptions,
  ): Provider {
    if (options.useFactory) {
      return {
        provide: AI_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject || [],
      }
    }

    return {
      provide: AI_MODULE_OPTIONS,
      useFactory: async (optionsFactory: AiOptionsFactory) => {
        return optionsFactory.createAiOptions()
      },
      inject: [options.useExisting || options.useClass!],
    }
  }
}
