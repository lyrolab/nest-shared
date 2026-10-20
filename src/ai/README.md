# AI Module

The AI module provides a standardized way to interact with AI models using OpenRouter, with built-in caching support.

## Dependencies

```bash
npm install ai@^7 @ai-sdk/provider@^4 @openrouter/ai-sdk-provider@^3
```

## Features

- OpenRouter integration with Google's Gemini model
- Bounded, model-scoped response caching with a hit marker
- OpenRouter embedding models
- Type-safe AI model interactions
- Configurable model selection

## Usage

1. Import and configure the AI module in your `app.module.ts`:

```typescript
import { SharedAiModule } from "@lyrolab/nest-shared/ai"

@Module({
  imports: [
    SharedAiModule.forRoot({
      apiKey: "your-openrouter-api-key",
      defaultModel: "google/gemini-2.0-flash-001",
      cacheTtlMs: 60_000,
    }),
  ],
})
export class AppModule {}
```

2. Use the AI service in your components:

```typescript
import { AiService } from "@lyrolab/nest-shared/ai"
import { generateText } from "ai"
import { Injectable } from "@nestjs/common"

@Injectable()
export class MyService {
  constructor(private readonly aiService: AiService) {}

  async generateResponse(system: string, prompt: string) {
    const result = await generateText({
      model: this.aiService.model,
      system,
      prompt,
    })
    return result.text
  }
}
```

3. Wrap any AI SDK language model (V2, V3 or V4 specification) with the response cache:

```typescript
import { anthropic } from "@ai-sdk/anthropic"

const model = this.aiService.wrapModel(anthropic("claude-sonnet-5"))
```

`model`, `buildModel()` and `wrapModel()` return a `LanguageModelV4`.

4. Build an OpenRouter embedding model:

```typescript
import { embed } from "ai"

const { embedding } = await embed({
  model: this.aiService.buildEmbeddingModel({
    model: "openai/text-embedding-3-small",
  }),
  value: "text to embed",
})
```

`buildEmbeddingModel({ model?, settings? })` returns an `EmbeddingModelV4`. `settings` is passed through as `OpenRouterEmbeddingSettings`. Embeddings are not cached.

The package is CommonJS; `ai` v7 is ESM-only and is loaded through Node's `require(esm)` support (Node >= 22).

## Configuration

The AI module is configured explicitly through module options:

- `apiKey` (required): OpenRouter API key used for authentication
- `defaultModel` (optional): fallback model used by `AiService.model` and `buildModel()`. Defaults to `google/gemini-2.0-flash-001`
- `defaultEmbeddingModel` (optional): fallback model used by `buildEmbeddingModel()`. Defaults to `openai/text-embedding-3-small`
- `cacheTtlMs` (optional): per-entry cache TTL in milliseconds for AI responses
  - `undefined`: 24 hours
  - `0`: cache disabled, no read and no write
  - negative: `AiService` throws at construction

Every cache write carries a positive TTL, so no AI response is stored without expiry.

## Response cache

`wrapGenerate` results of every model built by `model`, `buildModel()` or `wrapModel()` are cached through the shared cache module. Streams are not cached.

The cache key is:

```
ai:v2:<provider>/<modelId>:<sha256(JSON.stringify(params))>
```

`provider` and `modelId` come from the wrapped model, so two models given the same prompt never share an entry, and the key does not reveal the prompt. When `REDIS_KEY_PREFIX` is set, the stored Redis key is `<REDIS_KEY_PREFIX>:ai:v2:...`.

A result replayed from the cache carries `providerMetadata.aiCache = { hit: true }`, merged with the stored provider metadata. A middleware wrapped outside the AI service model can use it to tell a replay, which costs nothing, from a billed call. The stored entry never carries the marker, and a fresh result has no `aiCache` key.

You can also configure it asynchronously:

```typescript
import { ConfigService } from "@nestjs/config"
import { SharedAiModule } from "@lyrolab/nest-shared/ai"

@Module({
  imports: [
    SharedAiModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        apiKey: configService.getOrThrow<string>("OPENROUTER_API_KEY"),
        cacheTtlMs: configService.get<number>("AI_CACHE_TTL_MS"),
      }),
    }),
  ],
})
export class AppModule {}
```
