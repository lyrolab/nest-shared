import {
  EmbeddingModelV4,
  LanguageModelV4,
  LanguageModelV4Middleware,
} from "@ai-sdk/provider"
import { CACHE_MANAGER } from "@nestjs/cache-manager"
import { Inject, Injectable } from "@nestjs/common"
import {
  createOpenRouter,
  OpenRouterEmbeddingSettings,
  OpenRouterProvider,
} from "@openrouter/ai-sdk-provider"
import { wrapLanguageModel } from "ai"
import { Cache } from "cache-manager"
import { createHash } from "node:crypto"
import { AI_MODULE_OPTIONS } from "../ai.constants"
import { AiModuleOptions } from "../interfaces/ai-module-options.interface"

const DEFAULT_MODEL = "google/gemini-2.0-flash-001"
const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small"
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000

export type BuildModelOptions = {
  model?: string
}

export type BuildEmbeddingModelOptions = {
  model?: string
  settings?: OpenRouterEmbeddingSettings
}

export type WrappableLanguageModel = Parameters<
  typeof wrapLanguageModel
>[0]["model"]

type GenerateResult = Awaited<ReturnType<LanguageModelV4["doGenerate"]>>

@Injectable()
export class AiService {
  private readonly openrouter: OpenRouterProvider
  private readonly openrouterChat: LanguageModelV4
  private readonly cacheTtlMs: number

  constructor(
    @Inject(CACHE_MANAGER) private cache: Cache,
    @Inject(AI_MODULE_OPTIONS) private options: AiModuleOptions,
  ) {
    this.cacheTtlMs = this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    if (this.cacheTtlMs < 0) {
      throw new Error(
        `AiModuleOptions.cacheTtlMs must be >= 0, got ${this.cacheTtlMs}`,
      )
    }
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

  buildEmbeddingModel({
    model,
    settings,
  }: BuildEmbeddingModelOptions = {}): EmbeddingModelV4 {
    return this.openrouter.textEmbeddingModel(
      model ?? this.options.defaultEmbeddingModel ?? DEFAULT_EMBEDDING_MODEL,
      settings,
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
    model,
  }: Parameters<
    NonNullable<LanguageModelV4Middleware["wrapGenerate"]>
  >[0]): Promise<GenerateResult> {
    if (this.cacheTtlMs === 0) {
      return doGenerate()
    }

    const paramsHash = createHash("sha256")
      .update(JSON.stringify(params))
      .digest("hex")
    const cacheKey = `ai:v2:${model.provider}/${model.modelId}:${paramsHash}`

    const cachedResult = await this.cache.get<GenerateResult>(cacheKey)
    if (cachedResult) {
      return {
        ...cachedResult,
        providerMetadata: {
          ...cachedResult.providerMetadata,
          aiCache: { hit: true },
        },
      }
    }

    const result = await doGenerate()
    await this.cache.set(cacheKey, result, this.cacheTtlMs)
    return result
  }
}
