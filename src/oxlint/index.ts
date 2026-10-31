import { join } from "node:path"
import { recommendedRules, typeCheckedRules } from "./rules"

export { recommendedRules, typeCheckedRules } from "./rules"

type Severity = "off" | "warn" | "error"
type RuleEntry = Severity | [Severity, ...unknown[]]

export interface OxlintOverride {
  files: string[]
  excludeFiles?: string[]
  env?: Record<string, boolean>
  jsPlugins?: (string | { name: string; specifier: string })[]
  rules?: Record<string, RuleEntry>
}

export interface OxlintConfig {
  plugins: string[]
  jsPlugins: (string | { name: string; specifier: string })[]
  categories: Record<string, Severity>
  env: Record<string, boolean>
  ignorePatterns: string[]
  options?: { typeAware?: boolean }
  rules: Record<string, RuleEntry>
  overrides: OxlintOverride[]
}

export interface LyrolabNestOxlintOptions {
  /** Type-aware rules (`no-floating-promises`, `no-unsafe-*`, …) through oxlint-tsgolint. Default: true. */
  typeChecked?: boolean
  /** Extra ignore globs (generated files, build output). */
  ignores?: string[]
  /** Extra rules merged over the preset's. */
  rules?: Record<string, RuleEntry>
  /** Extra overrides appended after the preset's. Later overrides win. */
  overrides?: OxlintOverride[]
}

/** The `lyrolab` JS plugin: `lyrolab/restricted-syntax`, a port of `no-restricted-syntax`. */
export const lyrolabPlugin = {
  name: "lyrolab",
  specifier: join(__dirname, "plugin.js"),
}

const SPEC_FILES = ["**/*.spec.ts", "**/*.e2e-spec.ts"]

const JS_FILES = ["**/*.{js,mjs,cjs}"]

const off = (rules: Record<string, RuleEntry>) =>
  Object.fromEntries(Object.keys(rules).map((name) => [name, "off" as const]))

/**
 * Shared Lyrolab NestJS Oxlint config: `@eslint/js` and `typescript-eslint` recommended
 * (type-checked) equivalents plus Oxlint's correctness category.
 */
export function lyrolabNest({
  typeChecked = true,
  ignores = [],
  rules = {},
  overrides = [],
}: LyrolabNestOxlintOptions = {}): OxlintConfig {
  return {
    plugins: ["typescript", "unicorn", "oxc"],
    jsPlugins: [lyrolabPlugin],
    categories: { correctness: "error" },
    env: { node: true, es2024: true },
    ignorePatterns: ["node_modules/**", "dist/**", "coverage/**", ...ignores],
    ...(typeChecked && { options: { typeAware: true } }),
    rules: {
      ...recommendedRules,
      ...(typeChecked && {
        ...typeCheckedRules,
        "typescript/no-floating-promises": "warn",
        "typescript/no-unsafe-argument": "warn",
      }),
      "typescript/no-explicit-any": "off",
      // TypeORM entities and DTOs are plain data classes: spreading one into a partial is the
      // idiomatic copy, and spreading a string is the idiomatic way to count code points.
      "typescript/no-misused-spread": "off",
      ...rules,
    },
    overrides: [
      // JavaScript files sit outside the TypeScript program, so every value would type as `error`.
      ...(typeChecked
        ? [{ files: JS_FILES, rules: off(typeCheckedRules) }]
        : []),
      {
        files: SPEC_FILES,
        rules: {
          // expect(mock.method) on mocks is the canonical assertion pattern.
          "typescript/unbound-method": "off",
        },
      },
      ...overrides,
    ],
  }
}

export default lyrolabNest
