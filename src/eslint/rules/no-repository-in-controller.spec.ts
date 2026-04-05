import { RuleTester } from "eslint"
import { noRepositoryInController } from "./no-repository-in-controller"

const ruleTester = new RuleTester({
  languageOptions: {
    parser: require("typescript-eslint").parser,
  },
})

ruleTester.run(
  "no-repository-in-controller",
  noRepositoryInController as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      {
        code: `
        class BoardController {
          constructor(
            private readonly boardService: BoardService,
          ) {}
        }
      `,
      },
      {
        code: `
        class BoardService {
          constructor(
            private readonly boardRepository: BoardRepository,
          ) {}
        }
      `,
      },
      {
        code: `
        class BoardController {
          constructor(
            private readonly boardService: BoardService,
            private readonly authService: AuthService,
          ) {}
        }
      `,
      },
    ],
    invalid: [
      {
        code: `
        class BoardController {
          constructor(
            private readonly boardRepository: BoardRepository,
          ) {}
        }
      `,
        errors: [
          {
            messageId: "repositoryInController",
            data: { repositoryName: "BoardRepository" },
          },
        ],
      },
      {
        code: `
        class PostController {
          constructor(
            private readonly postRepository: PostRepository,
            private readonly tagRepository: TagRepository,
          ) {}
        }
      `,
        errors: [
          {
            messageId: "repositoryInController",
            data: { repositoryName: "PostRepository" },
          },
          {
            messageId: "repositoryInController",
            data: { repositoryName: "TagRepository" },
          },
        ],
      },
    ],
  },
)
