import { join } from "node:path"
import { lyrolabNest, lyrolabPlugin, typeCheckedRules } from "."

describe("lyrolabNest", () => {
  it("is type-aware and turns type-aware rules off for JavaScript files", () => {
    const config = lyrolabNest()

    expect(config.options).toEqual({ typeAware: true })
    expect(config.rules["typescript/no-floating-promises"]).toBe("warn")
    expect(config.overrides[0]).toEqual({
      files: ["**/*.{js,mjs,cjs}"],
      rules: Object.fromEntries(
        Object.keys(typeCheckedRules).map((name) => [name, "off"]),
      ),
    })
  })

  it("leaves type-aware rules out when typeChecked is false", () => {
    const config = lyrolabNest({ typeChecked: false })

    expect(config.options).toBeUndefined()
    expect(config.rules["typescript/no-floating-promises"]).toBeUndefined()
    expect(config.overrides.map((o) => o.files)).not.toContainEqual([
      "**/*.{js,mjs,cjs}",
    ])
  })

  it("merges rules, ignores and overrides after the preset's", () => {
    const override = {
      files: ["src/legacy/**"],
      rules: { eqeqeq: "off" as const },
    }
    const config = lyrolabNest({
      ignores: ["src/generated/**"],
      rules: { "typescript/no-explicit-any": "error" },
      overrides: [override],
    })

    expect(config.ignorePatterns).toContain("src/generated/**")
    expect(config.rules["typescript/no-explicit-any"]).toBe("error")
    expect(config.overrides.at(-1)).toBe(override)
  })

  it("points the lyrolab JS plugin at the compiled plugin file", () => {
    expect(lyrolabNest().jsPlugins).toContain(lyrolabPlugin)
    expect(lyrolabPlugin.specifier).toBe(join(__dirname, "plugin.js"))
  })
})
