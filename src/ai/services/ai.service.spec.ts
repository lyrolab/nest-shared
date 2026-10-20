import { CACHE_MANAGER } from "@nestjs/cache-manager"
import { Cache } from "cache-manager"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { wrapLanguageModel } from "ai"
import { AI_MODULE_OPTIONS } from "../ai.constants"
import { AiModuleOptions } from "../interfaces/ai-module-options.interface"
import { AiService } from "./ai.service"

jest.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: jest.fn(() => ({
    chat: jest.fn((model: string) => ({ model })),
    textEmbeddingModel: jest.fn((modelId: string, settings?: object) => ({
      specificationVersion: "v4",
      provider: "openrouter",
      modelId,
      settings,
    })),
  })),
}))

jest.mock("ai", () => ({
  wrapLanguageModel: jest.fn(({ model }: { model: unknown }) => model),
}))

type ModelRef = { provider: string; modelId: string }

type GenerateResult = {
  text: string
  providerMetadata?: Record<string, Record<string, unknown>>
}

const KEY_FORMAT = /^ai:v2:[^/]+\/[^:]+:[0-9a-f]{64}$/
const ONE_DAY_MS = 86_400_000

const chatModel: ModelRef = {
  provider: "openrouter.chat",
  modelId: "google/gemini-2.0-flash-001",
}

describe("AiService", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  const createService = (options: AiModuleOptions) => {
    const store = new Map<string, unknown>()
    const cache = {
      get: jest.fn((key: string) => Promise.resolve(store.get(key))),
      set: jest.fn<Promise<unknown>, [string, unknown, number?]>(
        (key, value) => {
          store.set(key, structuredClone(value))
          return Promise.resolve(value)
        },
      ),
    }

    const service = new AiService(cache as unknown as Cache, options)
    const generate = (
      result: GenerateResult,
      params: Record<string, unknown> = { prompt: "hello" },
      model: ModelRef = chatModel,
    ) =>
      (
        service as unknown as {
          wrapGenerate: (input: {
            doGenerate: () => Promise<GenerateResult>
            params: Record<string, unknown>
            model: ModelRef
          }) => Promise<GenerateResult>
        }
      ).wrapGenerate({
        doGenerate: () => Promise.resolve(result),
        params,
        model,
      })

    return { cache, store, service, generate }
  }

  it("uses configured default model when building service model", () => {
    const mockedCreateOpenRouter = jest.mocked(createOpenRouter)

    createService({
      apiKey: "test-key",
      defaultModel: "openai/gpt-4o-mini",
    })

    const openRouter = mockedCreateOpenRouter.mock.results[0]?.value as {
      chat: jest.Mock
    }

    expect(mockedCreateOpenRouter).toHaveBeenCalledWith({ apiKey: "test-key" })
    expect(openRouter.chat).toHaveBeenCalledWith("openai/gpt-4o-mini")
  })

  it("wraps models with a v4 middleware", () => {
    createService({ apiKey: "test-key" })

    const [options] = jest.mocked(wrapLanguageModel).mock.calls[0] ?? []
    const [middleware] = [options?.middleware].flat()

    expect(options?.model).toEqual({ model: "google/gemini-2.0-flash-001" })
    expect(middleware?.specificationVersion).toBe("v4")
    expect(middleware?.wrapGenerate).toBeInstanceOf(Function)
  })

  describe("cache TTL", () => {
    it("writes with a 24 hour TTL when cacheTtlMs is undefined", async () => {
      const { cache, generate } = createService({ apiKey: "test-key" })

      await generate({ text: "fresh" })

      expect(cache.set).toHaveBeenCalledWith(
        expect.stringMatching(KEY_FORMAT),
        { text: "fresh" },
        ONE_DAY_MS,
      )
    })

    it("writes with the configured TTL", async () => {
      const { cache, generate } = createService({
        apiKey: "test-key",
        cacheTtlMs: 60_000,
      })

      await generate({ text: "fresh" })

      expect(cache.set).toHaveBeenCalledWith(
        expect.stringMatching(KEY_FORMAT),
        { text: "fresh" },
        60_000,
      )
    })

    it.each([undefined, 1, 60_000])(
      "passes a positive TTL to every cache.set (cacheTtlMs: %p)",
      async (cacheTtlMs) => {
        const { cache, generate } = createService({
          apiKey: "test-key",
          cacheTtlMs,
        })

        await generate({ text: "a" }, { prompt: "a" })
        await generate({ text: "b" }, { prompt: "b" })

        expect(cache.set).toHaveBeenCalledTimes(2)
        for (const [, , ttl] of cache.set.mock.calls) {
          expect(ttl).toBeGreaterThan(0)
        }
      },
    )

    it("never touches the cache when cacheTtlMs is 0", async () => {
      const { cache, generate } = createService({
        apiKey: "test-key",
        cacheTtlMs: 0,
      })

      const first = await generate({ text: "fresh" })
      const second = await generate({ text: "fresh" })

      expect(first).toEqual({ text: "fresh" })
      expect(second).toEqual({ text: "fresh" })
      expect(cache.get).not.toHaveBeenCalled()
      expect(cache.set).not.toHaveBeenCalled()
    })

    it("throws at construction when cacheTtlMs is negative", () => {
      expect(() =>
        createService({ apiKey: "test-key", cacheTtlMs: -1 }),
      ).toThrow(/cacheTtlMs/)
    })
  })

  describe("cache key", () => {
    it("scopes the key to the provider and model id", async () => {
      const { cache, generate } = createService({ apiKey: "test-key" })

      await generate({ text: "a" }, { prompt: "same" }, chatModel)
      await generate(
        { text: "b" },
        { prompt: "same" },
        { provider: "anthropic.messages", modelId: "claude-sonnet-5" },
      )

      const [firstKey, secondKey] = cache.set.mock.calls.map(([key]) => key)
      expect(firstKey).toMatch(KEY_FORMAT)
      expect(secondKey).toMatch(KEY_FORMAT)
      expect(firstKey).not.toBe(secondKey)
      expect(firstKey).toMatch(
        /^ai:v2:openrouter\.chat\/google\/gemini-2\.0-flash-001:/,
      )
      expect(secondKey).toMatch(/^ai:v2:anthropic\.messages\/claude-sonnet-5:/)
    })

    it("does not expose the prompt in the key", async () => {
      const { cache, generate } = createService({ apiKey: "test-key" })

      await generate({ text: "a" }, { prompt: "secret prompt" })

      expect(cache.set.mock.calls[0]?.[0]).not.toContain("secret")
    })
  })

  describe("cache hit marker", () => {
    it("marks a replayed result and never stores the marker", async () => {
      const { cache, store, generate } = createService({ apiKey: "test-key" })
      const generated: GenerateResult = {
        text: "fresh",
        providerMetadata: { openrouter: { usage: { cost: 0.002 } } },
      }

      const miss = await generate(generated)
      const hit = await generate({ text: "unused" })

      expect(miss.providerMetadata?.aiCache).toBeUndefined()
      expect(hit).toEqual({
        text: "fresh",
        providerMetadata: {
          openrouter: { usage: { cost: 0.002 } },
          aiCache: { hit: true },
        },
      })
      expect(cache.set).toHaveBeenCalledTimes(1)
      const [stored] = [...store.values()] as GenerateResult[]
      expect(stored.providerMetadata?.aiCache).toBeUndefined()
    })

    it("marks a replayed result that had no provider metadata", async () => {
      const { generate } = createService({ apiKey: "test-key" })

      await generate({ text: "fresh" })
      const hit = await generate({ text: "unused" })

      expect(hit.providerMetadata).toEqual({ aiCache: { hit: true } })
    })
  })

  describe("buildEmbeddingModel", () => {
    const openRouter = () =>
      jest.mocked(createOpenRouter).mock.results[0]?.value as {
        textEmbeddingModel: jest.Mock
      }

    it("returns an uncached OpenRouter embedding model with the requested id", () => {
      const { service } = createService({ apiKey: "test-key" })

      const model = service.buildEmbeddingModel({
        model: "openai/text-embedding-3-large",
        settings: { user: "user-1" },
      })

      expect(model.specificationVersion).toBe("v4")
      expect(model.modelId).toBe("openai/text-embedding-3-large")
      expect(openRouter().textEmbeddingModel).toHaveBeenCalledWith(
        "openai/text-embedding-3-large",
        { user: "user-1" },
      )
      expect(wrapLanguageModel).toHaveBeenCalledTimes(1)
    })

    it("falls back to defaultEmbeddingModel", () => {
      const { service } = createService({
        apiKey: "test-key",
        defaultEmbeddingModel: "openai/text-embedding-3-small",
      })

      expect(service.buildEmbeddingModel().modelId).toBe(
        "openai/text-embedding-3-small",
      )
    })
  })

  it("exposes expected injection tokens", () => {
    expect(CACHE_MANAGER).toBeDefined()
    expect(AI_MODULE_OPTIONS).toBe("AI_MODULE_OPTIONS")
  })
})
