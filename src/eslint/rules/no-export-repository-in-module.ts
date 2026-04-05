import { AST_NODE_TYPES, ESLintUtils, TSESTree } from "@typescript-eslint/utils"

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/lyrolab/nest-shared#${name}`,
)

type MessageIds = "exportedRepository"

export const noExportRepositoryInModule = createRule<[], MessageIds>({
  name: "no-export-repository-in-module",
  meta: {
    type: "problem",
    docs: {
      description:
        "NestJS modules must not export Repository classes. Repositories should stay in providers. Expose a Service instead.",
    },
    messages: {
      exportedRepository:
        "'{{ repositoryName }}' must not be exported from a module. Keep repositories private and expose a Service method instead.",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      ClassDeclaration(node) {
        const decorators = node.decorators ?? []
        const moduleDecorator = decorators.find((d) => {
          const expr = d.expression
          return (
            expr.type === AST_NODE_TYPES.CallExpression &&
            expr.callee.type === AST_NODE_TYPES.Identifier &&
            expr.callee.name === "Module"
          )
        })

        if (!moduleDecorator) return

        const expr = moduleDecorator.expression
        if (expr.type !== AST_NODE_TYPES.CallExpression) return

        const args = expr.arguments
        if (!args.length || args[0].type !== AST_NODE_TYPES.ObjectExpression)
          return

        const exportsProperty = args[0].properties.find(
          (prop): prop is TSESTree.Property =>
            prop.type === AST_NODE_TYPES.Property &&
            prop.key.type === AST_NODE_TYPES.Identifier &&
            prop.key.name === "exports",
        )
        if (
          !exportsProperty ||
          exportsProperty.value.type !== AST_NODE_TYPES.ArrayExpression
        )
          return

        for (const element of exportsProperty.value.elements) {
          if (
            element?.type === AST_NODE_TYPES.Identifier &&
            element.name.endsWith("Repository")
          ) {
            context.report({
              node: element,
              messageId: "exportedRepository",
              data: { repositoryName: element.name },
            })
          }
        }
      },
    }
  },
})
