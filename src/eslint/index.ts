import type { TSESLint } from "@typescript-eslint/utils"
import { noTypeormInNonRepository } from "./rules/no-typeorm-in-non-repository"
import { noRepositoryInController } from "./rules/no-repository-in-controller"
import { noExportRepositoryInModule } from "./rules/no-export-repository-in-module"

const plugin: TSESLint.FlatConfig.Plugin = {
  meta: {
    name: "@lyrolab/nestjs-architecture",
  },
  rules: {
    "no-typeorm-in-non-repository": noTypeormInNonRepository,
    "no-repository-in-controller": noRepositoryInController,
    "no-export-repository-in-module": noExportRepositoryInModule,
  },
}

const recommended: TSESLint.FlatConfig.Config = {
  plugins: {
    "@lyrolab/nestjs-architecture": plugin,
  },
  rules: {
    "@lyrolab/nestjs-architecture/no-typeorm-in-non-repository": "error",
    "@lyrolab/nestjs-architecture/no-repository-in-controller": "error",
    "@lyrolab/nestjs-architecture/no-export-repository-in-module": "error",
  },
}

export const nestArchitecturePlugin = { ...plugin, configs: { recommended } }
