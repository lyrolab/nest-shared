# AI Module

The AI module provides a standardized way to interact with AI models using OpenRouter, with built-in caching support.

## Dependencies

```bash
npm install ai@^7 @ai-sdk/provider@^4 @openrouter/ai-sdk-provider@^3
```

## Features

- OpenRouter integration with Google's Gemini model
- Automatic response caching
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

The package is CommonJS; `ai` v7 is ESM-only and is loaded through Node's `require(esm)` support (Node >= 22).

## Configuration

The AI module is configured explicitly through module options:

- `apiKey` (required): OpenRouter API key used for authentication
- `defaultModel` (optional): fallback model used by `AiService.model`
- `cacheTtlMs` (optional): per-entry cache TTL in milliseconds for AI responses

The module configures:

- Response caching using the shared cache module
- Default model selection (Google Gemini 2.0 Flash)
- Type-safe model interactions

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
