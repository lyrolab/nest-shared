// Oxlint JS plugin with the ESLint core rules Oxlint does not implement natively.
// Rules use the ESLint rule API, so the plugin also loads in ESLint.

type Node = object

interface RuleContext {
  options: { selector: string; message?: string }[]
  report(descriptor: { node: Node; message: string }): void
}

const restrictedSyntax = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow syntax matched by ESLint selectors, like ESLint's no-restricted-syntax.",
    },
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          selector: { type: "string" },
          message: { type: "string" },
        },
        required: ["selector"],
        additionalProperties: false,
      },
    },
  },
  create(context: RuleContext) {
    return Object.fromEntries(
      context.options.map(({ selector, message }) => [
        selector,
        (node: Node) =>
          context.report({
            node,
            message: message ?? `Using '${selector}' is not allowed.`,
          }),
      ]),
    )
  },
}

// Oxlint loads the plugin as the default import of this CommonJS file, which is
// `module.exports`, so `meta` and `rules` are top-level named exports.
export const meta = { name: "lyrolab" }

export const rules = { "restricted-syntax": restrictedSyntax }
