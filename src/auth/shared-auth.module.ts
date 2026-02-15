import { DynamicModule, Module, Provider } from "@nestjs/common"
import { PassportModule } from "@nestjs/passport"
import { AUTH_MODULE_OPTIONS } from "./auth.constants"
import { JwtAuthGuard } from "./guards/jwt-auth.guard"
import {
  AuthModuleAsyncOptions,
  AuthModuleOptions,
  AuthOptionsFactory,
} from "./interfaces/auth-module-options.interface"
import { JwtStrategy } from "./strategies/jwt.strategy"

@Module({})
export class SharedAuthModule {
  static forRoot(options: AuthModuleOptions): DynamicModule {
    return {
      module: SharedAuthModule,
      global: true,
      imports: [PassportModule.register({ defaultStrategy: "jwt" })],
      providers: [
        {
          provide: AUTH_MODULE_OPTIONS,
          useValue: options,
        },
        JwtStrategy,
        JwtAuthGuard,
      ],
      exports: [AUTH_MODULE_OPTIONS, JwtAuthGuard],
    }
  }

  static forRootAsync(options: AuthModuleAsyncOptions): DynamicModule {
    return {
      module: SharedAuthModule,
      global: true,
      imports: [
        PassportModule.register({ defaultStrategy: "jwt" }),
        ...(options.imports || []),
      ],
      providers: [
        ...this.createAsyncProviders(options),
        JwtStrategy,
        JwtAuthGuard,
      ],
      exports: [AUTH_MODULE_OPTIONS, JwtAuthGuard],
    }
  }

  private static createAsyncProviders(
    options: AuthModuleAsyncOptions,
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
    options: AuthModuleAsyncOptions,
  ): Provider {
    if (options.useFactory) {
      return {
        provide: AUTH_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject || [],
      }
    }

    return {
      provide: AUTH_MODULE_OPTIONS,
      useFactory: async (optionsFactory: AuthOptionsFactory) => {
        return optionsFactory.createAuthOptions()
      },
      inject: [options.useExisting || options.useClass!],
    }
  }
}
