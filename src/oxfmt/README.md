# Oxfmt Module — `@lyrolab/nest-shared/oxfmt`

Shared [Oxfmt](https://oxc.rs/docs/guide/usage/formatter) config: the Lyrolab NestJS Prettier style (no semicolons, double quotes, trailing commas, 80 columns).

## How Do I Use It?

Install the formatter: `npm i -D oxfmt`.

```typescript
// oxfmt.config.ts
import { lyrolabOxfmt } from "@lyrolab/nest-shared/oxfmt"

export default { ...lyrolabOxfmt, ignorePatterns: ["src/generated/**"] }
```

## What It Exports

| Export         | Type   | Description                             |
| -------------- | ------ | --------------------------------------- |
| `lyrolabOxfmt` | object | Oxfmt options (also the default export) |
