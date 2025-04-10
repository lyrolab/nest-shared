# AI Module

The AI module provides a standardized way to interact with AI models using OpenRouter, with built-in caching support.

## Dependencies

```bash
npm install @openrouter/ai-sdk-provider ai
```

## Features

- OpenRouter integration with Google's Gemini model
- Automatic response caching
- Type-safe AI model interactions
- Configurable model selection

## Usage

1. Import the AI module in your `app.module.ts`:

```typescript
import { AiModule } from "@lyrolab/nest-shared/ai"

@Module({
  imports: [AiModule],
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

## Configuration

The AI module requires the following environment variable:

- `OPENROUTER_API_KEY`: Your OpenRouter API key for authentication

The module automatically configures:

- Response caching using the shared cache module
- Default model selection (Google Gemini 2.0 Flash)
- Type-safe model interactions
