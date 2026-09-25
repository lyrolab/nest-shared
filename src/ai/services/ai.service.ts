import { LanguageModelV4, LanguageModelV4Middleware } from "@ai-sdk/provider"
import { CACHE_MANAGER } from "@nestjs/cache-manager"
import { Inject, Injectable } from "@nestjs/common"
import {
  createOpenRouter,
  OpenRouterProvider,
} from "@openrouter/ai-sdk-provider"
import { wrapLanguageModel } from "ai"
import { Cache } from "cache-manager"
import { AI_MODULE_OPTIONS } from "../ai.constants"
import { AiModuleOptions } from "../interfaces/ai-module-options.interface"

const DEFAULT_MODEL = "google/gemini-2.0-flash-001"

export type BuildModelOptions = {
  model?: string
}

export type WrappableLanguageModel = Parameters<
  typeof wrapLanguageModel
>[0]["model"]

type GenerateResult = Awaited<ReturnType<LanguageModelV4["doGenerate"]>>

@Injectable()
export class AiService {
  private readonly openrouter: OpenRouterProvider
  private readonly openrouterChat: LanguageModelV4

  constructor(
    @Inject(CACHE_MANAGER) private cache: Cache,
    @Inject(AI_MODULE_OPTIONS) private options: AiModuleOptions,
  ) {
    this.openrouter = createOpenRouter({
      apiKey: this.options.apiKey,
    })
    this.openrouterChat = this.buildModel()
  }

  get model(): LanguageModelV4 {
    return this.openrouterChat
  }

  buildModel({ model }: BuildModelOptions = {}): LanguageModelV4 {
    return this.wrapModel(
      this.openrouter.chat(model ?? this.options.defaultModel ?? DEFAULT_MODEL),
    )
  }

  wrapModel(model: WrappableLanguageModel): LanguageModelV4 {
    return wrapLanguageModel({
      model,
      middleware: [
        {
          specificationVersion: "v4",
          wrapGenerate: (options) => this.wrapGenerate(options),
        },
      ],
    })
  }

  private async wrapGenerate({
    doGenerate,
    params,
  }: Parameters<
    NonNullable<LanguageModelV4Middleware["wrapGenerate"]>
  >[0]): Promise<GenerateResult> {
    const cacheKey = "ai:" + JSON.stringify(params)

    const cachedResult = await this.cache.get<GenerateResult>(cacheKey)
    if (cachedResult) {
      return cachedResult
    }

    const result = await doGenerate()

    if (this.options.cacheTtlMs !== undefined) {
      await this.cache.set(cacheKey, result, this.options.cacheTtlMs)
      return result
    }

    await this.cache.set(cacheKey, result)
    return result
  }
}
