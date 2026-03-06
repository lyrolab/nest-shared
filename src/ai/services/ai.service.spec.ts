import { CACHE_MANAGER } from "@nestjs/cache-manager"
import { Cache } from "cache-manager"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { AI_MODULE_OPTIONS } from "../ai.constants"
import { AiModuleOptions } from "../interfaces/ai-module-options.interface"
import { AiService } from "./ai.service"

jest.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: jest.fn(() => ({
    chat: jest.fn((model: string) => ({ model })),
  })),
}))

jest.mock("ai", () => ({
  wrapLanguageModel: jest.fn(({ model }: { model: unknown }) => model),
}))

type CacheMock = Pick<Cache, "get" | "set">

describe("AiService", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  const createService = (
    options: AiModuleOptions,
    cacheOverrides: Partial<CacheMock> = {},
  ) => {
    const cache: CacheMock = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      ...cacheOverrides,
    }

    const service = new AiService(
      cache as unknown as Cache,
      options,
    ) as unknown as {
      wrapGenerate: (input: {
        doGenerate: () => Promise<unknown>
        params: Record<string, unknown>
      }) => Promise<unknown>
      buildModel: (input?: { model?: string }) => unknown
    }

    return {
      cache,
      service,
    }
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

  it("returns cached value and skips generation on cache hit", async () => {
    const cached = { text: "cached" }
    const { cache, service } = createService(
      {
        apiKey: "test-key",
      },
      {
        get: jest.fn().mockResolvedValue(cached),
      },
    )
    const doGenerate = jest.fn().mockResolvedValue({ text: "fresh" })

    const result = await service.wrapGenerate({
      doGenerate,
      params: { prompt: "hello" },
    })

    expect(result).toEqual(cached)
    expect(cache.get).toHaveBeenCalledWith('ai:{"prompt":"hello"}')
    expect(doGenerate).not.toHaveBeenCalled()
    expect(cache.set).not.toHaveBeenCalled()
  })

  it("caches generated value with ttl when cacheTtlMs is configured", async () => {
    const generated = { text: "fresh" }
    const { cache, service } = createService({
      apiKey: "test-key",
      cacheTtlMs: 60_000,
    })
    const doGenerate = jest.fn().mockResolvedValue(generated)

    const result = await service.wrapGenerate({
      doGenerate,
      params: { prompt: "hello" },
    })

    expect(result).toEqual(generated)
    expect(cache.set).toHaveBeenCalledWith(
      'ai:{"prompt":"hello"}',
      generated,
      60_000,
    )
  })

  it("caches generated value without ttl override when cacheTtlMs is undefined", async () => {
    const generated = { text: "fresh" }
    const { cache, service } = createService({
      apiKey: "test-key",
    })
    const doGenerate = jest.fn().mockResolvedValue(generated)

    const result = await service.wrapGenerate({
      doGenerate,
      params: { prompt: "hello" },
    })

    expect(result).toEqual(generated)
    expect(cache.set).toHaveBeenCalledWith('ai:{"prompt":"hello"}', generated)
  })

  it("exposes expected injection tokens", () => {
    expect(CACHE_MANAGER).toBeDefined()
    expect(AI_MODULE_OPTIONS).toBe("AI_MODULE_OPTIONS")
  })
})
