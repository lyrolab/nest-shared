import { RuleTester } from "eslint"
import { noExportRepositoryInModule } from "./no-export-repository-in-module"

const ruleTester = new RuleTester({
  languageOptions: {
    parser: require("typescript-eslint").parser,
  },
})

ruleTester.run(
  "no-export-repository-in-module",
  noExportRepositoryInModule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      {
        code: `
        @Module({
          providers: [BoardRepository, BoardService],
          exports: [BoardService],
        })
        class BoardModule {}
      `,
      },
      {
        code: `
        @Module({
          providers: [BoardRepository],
          controllers: [BoardController],
        })
        class BoardModule {}
      `,
      },
      {
        code: `
        @Module({
          exports: [BoardSharedModule],
        })
        class BoardModule {}
      `,
      },
      {
        code: `
        @Module({
          imports: [TypeOrmModule.forFeature([Board])],
          providers: [BoardRepository, BoardService],
          exports: [BoardService],
        })
        class BoardModule {}
      `,
      },
    ],
    invalid: [
      {
        code: `
        @Module({
          providers: [BoardRepository, BoardService],
          exports: [BoardRepository],
        })
        class BoardModule {}
      `,
        errors: [
          {
            messageId: "exportedRepository",
            data: { repositoryName: "BoardRepository" },
          },
        ],
      },
      {
        code: `
        @Module({
          exports: [BoardRepository, TagRepository],
        })
        class BoardModule {}
      `,
        errors: [
          {
            messageId: "exportedRepository",
            data: { repositoryName: "BoardRepository" },
          },
          {
            messageId: "exportedRepository",
            data: { repositoryName: "TagRepository" },
          },
        ],
      },
      {
        code: `
        @Module({
          exports: [BoardService, PostRepository],
        })
        class BoardModule {}
      `,
        errors: [
          {
            messageId: "exportedRepository",
            data: { repositoryName: "PostRepository" },
          },
        ],
      },
    ],
  },
)
