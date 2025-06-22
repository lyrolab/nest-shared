import { CACHE_MANAGER } from "@nestjs/cache-manager"
import { Inject, Injectable } from "@nestjs/common"
import {
  createOpenRouter,
  OpenRouterProvider,
} from "@openrouter/ai-sdk-provider"
import {
  LanguageModelV1,
  LanguageModelV1Middleware,
  wrapLanguageModel,
} from "ai"
import { Cache } from "cache-manager"

const DEFAULT_MODEL = "google/gemini-2.0-flash-001"

export type BuildModelOptions = {
  model?: string
}

@Injectable()
export class AiService {
  private readonly openrouter: OpenRouterProvider
  private readonly openrouterChat: LanguageModelV1

  constructor(@Inject(CACHE_MANAGER) private cache: Cache) {
    this.openrouter = createOpenRouter({
      apiKey: process.env.OPENROUTER_API_KEY,
    })
    this.openrouterChat = this.buildModel()
  }

  get model() {
    return this.openrouterChat
  }

  buildModel({ model }: BuildModelOptions = {}) {
    return this.wrapModel(this.openrouter.chat(model ?? DEFAULT_MODEL))
  }

  wrapModel(model: LanguageModelV1) {
    return wrapLanguageModel({
      model,
      middleware: [{ wrapGenerate: (options) => this.wrapGenerate(options) }],
    })
  }

  private async wrapGenerate({
    doGenerate,
    params,
  }: Parameters<
    NonNullable<LanguageModelV1Middleware["wrapGenerate"]>
  >[0]): Promise<Awaited<ReturnType<LanguageModelV1["doGenerate"]>>> {
    const cacheKey = "ai:" + JSON.stringify(params)

    const cachedResult = await this.cache.get(cacheKey)
    if (cachedResult) {
      return cachedResult as Awaited<ReturnType<LanguageModelV1["doGenerate"]>>
    }

    const result = await doGenerate()

    await this.cache.set(cacheKey, result)
    return result
  }
}
