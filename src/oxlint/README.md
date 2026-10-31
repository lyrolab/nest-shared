# Oxlint Module — `@lyrolab/nest-shared/oxlint`

Shared [Oxlint](https://oxc.rs/docs/guide/usage/linter) config for NestJS projects.

## What Is This?

`lyrolabNest()` returns an Oxlint config with:

- Oxlint's `correctness` category for the `typescript`, `unicorn` and `oxc` plugins.
- The Oxlint equivalents of `@eslint/js` and `typescript-eslint` recommended.
- The type-aware rules of `typescript-eslint` recommended-type-checked (`no-floating-promises`, `no-unsafe-*`, …), run by `oxlint-tsgolint`. `no-floating-promises` and `no-unsafe-argument` warn, and the type-aware rules are off for JavaScript files, which sit outside the TypeScript program.
- `typescript/no-explicit-any` and `typescript/no-misused-spread` off, and `typescript/unbound-method` off in specs (`expect(mock.method)`).
- The `lyrolab` JS plugin, whose `lyrolab/restricted-syntax` rule is ESLint's `no-restricted-syntax`, which Oxlint does not implement.

## How Do I Use It?

Install the linter: `npm i -D oxlint oxlint-tsgolint`.

```javascript
// oxlint.config.mjs (run with `oxlint -c oxlint.config.mjs`)
import { defineConfig } from "oxlint"
import { lyrolabNest } from "@lyrolab/nest-shared/oxlint"

export default defineConfig(
  lyrolabNest({
    ignores: ["src/generated/**"],
    rules: { "typescript/no-explicit-any": "warn" },
    overrides: [
      {
        files: ["src/**/*.ts"],
        excludeFiles: ["**/*.spec.ts"],
        rules: {
          "lyrolab/restricted-syntax": [
            "error",
            {
              selector: "Literal[value=/\\bAcme\\b/]",
              message: "Call productName().",
            },
          ],
        },
      },
    ],
  }),
)
```

Options:

| Option        | Default | Purpose                                                         |
| ------------- | ------- | --------------------------------------------------------------- |
| `typeChecked` | `true`  | Type-aware rules and `options.typeAware`.                       |
| `ignores`     | `[]`    | Extra ignore globs (`node_modules`, `dist`, `coverage` always). |
| `rules`       | `{}`    | Rules merged over the preset's.                                 |
| `overrides`   | `[]`    | Overrides appended after the preset's. Later overrides win.     |

## What It Exports

| Export             | Type     | Description                                                    |
| ------------------ | -------- | -------------------------------------------------------------- |
| `lyrolabNest`      | function | The config factory (also the default export)                   |
| `lyrolabPlugin`    | object   | The `lyrolab` JS plugin entry (`{ name, specifier }`)          |
| `recommendedRules` | object   | `@eslint/js` and `typescript-eslint` recommended, Oxlint names |
| `typeCheckedRules` | object   | `typescript-eslint` recommended-type-checked, Oxlint names     |
