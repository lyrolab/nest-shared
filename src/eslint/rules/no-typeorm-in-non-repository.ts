import { AST_NODE_TYPES, ESLintUtils, TSESTree } from "@typescript-eslint/utils"

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/lyrolab/nest-shared#${name}`,
)

type MessageIds = "injectRepository" | "dataSource"

function getClassName(node: TSESTree.ClassDeclaration): string | undefined {
  return node.id?.name
}

function getConstructor(
  node: TSESTree.ClassDeclaration,
): TSESTree.MethodDefinition | undefined {
  return node.body.body.find(
    (member): member is TSESTree.MethodDefinition =>
      member.type === AST_NODE_TYPES.MethodDefinition &&
      member.kind === "constructor",
  )
}

export const noTypeormInNonRepository = createRule<[], MessageIds>({
  name: "no-typeorm-in-non-repository",
  meta: {
    type: "problem",
    docs: {
      description:
        "@InjectRepository() and DataSource injection are only allowed in Repository classes",
    },
    messages: {
      injectRepository:
        "@InjectRepository() can only be used in classes ending with 'Repository'. Move data access logic to a Repository class.",
      dataSource:
        "DataSource can only be injected in classes ending with 'Repository'. Move data access logic to a Repository class.",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      ClassDeclaration(node) {
        const className = getClassName(node)
        if (!className || className.endsWith("Repository")) return

        const ctor = getConstructor(node)
        if (!ctor) return

        const ctorValue = ctor.value
        if (ctorValue.type !== AST_NODE_TYPES.FunctionExpression) return

        for (const param of ctorValue.params) {
          const actualParam =
            param.type === AST_NODE_TYPES.TSParameterProperty
              ? param.parameter
              : param
          const decorators =
            "decorators" in param ? (param.decorators ?? []) : []

          for (const decorator of decorators) {
            const expr = decorator.expression
            if (
              expr.type === AST_NODE_TYPES.CallExpression &&
              expr.callee.type === AST_NODE_TYPES.Identifier &&
              expr.callee.name === "InjectRepository"
            ) {
              context.report({
                node: decorator,
                messageId: "injectRepository",
              })
            }
          }

          const typeAnnotation =
            "typeAnnotation" in actualParam
              ? actualParam.typeAnnotation?.typeAnnotation
              : undefined
          if (
            typeAnnotation?.type === AST_NODE_TYPES.TSTypeReference &&
            typeAnnotation.typeName.type === AST_NODE_TYPES.Identifier &&
            typeAnnotation.typeName.name === "DataSource"
          ) {
            context.report({
              node: param,
              messageId: "dataSource",
            })
          }
        }
      },
    }
  },
})
