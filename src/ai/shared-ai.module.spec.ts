import { DynamicModule } from "@nestjs/common"
import { SharedCacheModule } from "../cache"
import { AI_MODULE_OPTIONS } from "./ai.constants"
import {
  AiModuleAsyncOptions,
  AiOptionsFactory,
} from "./interfaces/ai-module-options.interface"
import { AiService } from "./services/ai.service"
import { SharedAiModule } from "./shared-ai.module"

class AiOptionsFactoryStub implements AiOptionsFactory {
  createAiOptions() {
    return {
      apiKey: "factory-key",
      defaultModel: "google/gemini-2.0-flash-001",
      cacheTtlMs: 30_000,
    }
  }
}

describe("SharedAiModule", () => {
  const hasSharedCacheImport = (dynamicModule: DynamicModule) =>
    (dynamicModule.imports ?? []).some(
      (importedModule) =>
        typeof importedModule === "object" &&
        "module" in importedModule &&
        importedModule.module === SharedCacheModule,
    )

  it("forRoot provides AI module options and service", () => {
    const options = {
      apiKey: "test-key",
      cacheTtlMs: 60_000,
    }
    const dynamicModule = SharedAiModule.forRoot(options)

    expect(dynamicModule.module).toBe(SharedAiModule)
    expect(dynamicModule.global).toBe(false)
    expect(hasSharedCacheImport(dynamicModule)).toBe(true)

    expect(dynamicModule.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provide: AI_MODULE_OPTIONS,
          useValue: options,
        }),
        AiService,
      ]),
    )
    expect(dynamicModule.exports).toEqual([AiService])
  })

  it("forRootAsync supports useFactory options", () => {
    const asyncOptions: AiModuleAsyncOptions = {
      inject: ["CONFIG_TOKEN"],
      useFactory: (config: { apiKey: string }) => ({
        apiKey: config.apiKey,
        cacheTtlMs: 15_000,
      }),
    }
    const dynamicModule = SharedAiModule.forRootAsync(asyncOptions)

    expect(dynamicModule.module).toBe(SharedAiModule)
    expect(dynamicModule.global).toBe(false)
    expect(hasSharedCacheImport(dynamicModule)).toBe(true)
    expect(dynamicModule.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provide: AI_MODULE_OPTIONS,
          inject: ["CONFIG_TOKEN"],
        }),
        AiService,
      ]),
    )
  })

  it("forRootAsync supports useClass options factory", () => {
    const dynamicModule = SharedAiModule.forRootAsync({
      useClass: AiOptionsFactoryStub,
    })

    expect(hasSharedCacheImport(dynamicModule)).toBe(true)
    expect(dynamicModule.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provide: AI_MODULE_OPTIONS,
          inject: [AiOptionsFactoryStub],
        }),
        expect.objectContaining({
          provide: AiOptionsFactoryStub,
          useClass: AiOptionsFactoryStub,
        }),
        AiService,
      ]),
    )
  })
})
