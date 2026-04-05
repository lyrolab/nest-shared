import { AST_NODE_TYPES, ESLintUtils, TSESTree } from "@typescript-eslint/utils"

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/lyrolab/nest-shared#${name}`,
)

type MessageIds = "repositoryInController"

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

export const noRepositoryInController = createRule<[], MessageIds>({
  name: "no-repository-in-controller",
  meta: {
    type: "problem",
    docs: {
      description:
        "Controllers must not inject Repository classes directly. Use a Service as intermediary.",
    },
    messages: {
      repositoryInController:
        "'{{ repositoryName }}' must not be injected in a Controller. Controllers should depend on Services, not Repositories.",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      ClassDeclaration(node) {
        const className = getClassName(node)
        if (!className || !className.endsWith("Controller")) return

        const ctor = getConstructor(node)
        if (!ctor) return

        const ctorValue = ctor.value
        if (ctorValue.type !== AST_NODE_TYPES.FunctionExpression) return

        for (const param of ctorValue.params) {
          const actualParam =
            param.type === AST_NODE_TYPES.TSParameterProperty
              ? param.parameter
              : param
          const typeAnnotation =
            "typeAnnotation" in actualParam
              ? actualParam.typeAnnotation?.typeAnnotation
              : undefined

          if (
            typeAnnotation?.type === AST_NODE_TYPES.TSTypeReference &&
            typeAnnotation.typeName.type === AST_NODE_TYPES.Identifier &&
            typeAnnotation.typeName.name.endsWith("Repository")
          ) {
            context.report({
              node: param,
              messageId: "repositoryInController",
              data: { repositoryName: typeAnnotation.typeName.name },
            })
          }
        }
      },
    }
  },
})
