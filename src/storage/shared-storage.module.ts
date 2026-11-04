import { DynamicModule, Module } from "@nestjs/common"
import {
  StorageAsyncOptions,
  StorageOptions,
} from "./interfaces/storage-options.interface"
import { InMemoryStorageService } from "./services/in-memory-storage.service"
import { StorageService } from "./services/storage.service"
import { STORAGE_OPTIONS } from "./storage.constants"

@Module({})
export class SharedStorageModule {
  static forRoot(options: StorageOptions): DynamicModule {
    return SharedStorageModule.forRootAsync({ useFactory: () => options })
  }

  static forRootAsync(options: StorageAsyncOptions): DynamicModule {
    return {
      module: SharedStorageModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: STORAGE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        {
          provide: StorageService,
          inject: [STORAGE_OPTIONS],
          // Loaded on demand so that apps using only forTest() never need the
          // optional @aws-sdk/client-s3 peer dependency.
          useFactory: async (storageOptions: StorageOptions) => {
            const { S3StorageService } = await import(
              "./services/s3-storage.service"
            )
            return new S3StorageService(storageOptions)
          },
        },
      ],
      exports: [StorageService],
    }
  }

  static forTest(): DynamicModule {
    return {
      module: SharedStorageModule,
      providers: [
        InMemoryStorageService,
        { provide: StorageService, useExisting: InMemoryStorageService },
      ],
      exports: [StorageService, InMemoryStorageService],
    }
  }
}
