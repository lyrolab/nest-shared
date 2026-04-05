import { RuleTester } from "eslint"
import { noTypeormInNonRepository } from "./no-typeorm-in-non-repository"

const ruleTester = new RuleTester({
  languageOptions: {
    parser: require("typescript-eslint").parser,
  },
})

ruleTester.run(
  "no-typeorm-in-non-repository",
  noTypeormInNonRepository as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      {
        code: `
        class BoardRepository {
          constructor(
            @InjectRepository(Board)
            private readonly boardRepo: Repository<Board>,
            private readonly dataSource: DataSource,
          ) {}
        }
      `,
      },
      {
        code: `
        class CustomBoardRepository {
          constructor(
            @InjectRepository(Board)
            private readonly boardRepo: Repository<Board>,
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
          ) {}
        }
      `,
      },
    ],
    invalid: [
      {
        code: `
        class BoardService {
          constructor(
            @InjectRepository(Board)
            private readonly boardRepo: Repository<Board>,
          ) {}
        }
      `,
        errors: [{ messageId: "injectRepository" }],
      },
      {
        code: `
        class BoardService {
          constructor(
            private readonly dataSource: DataSource,
          ) {}
        }
      `,
        errors: [{ messageId: "dataSource" }],
      },
      {
        code: `
        class BoardController {
          constructor(
            @InjectRepository(Board)
            private readonly boardRepo: Repository<Board>,
            private readonly dataSource: DataSource,
          ) {}
        }
      `,
        errors: [
          { messageId: "injectRepository" },
          { messageId: "dataSource" },
        ],
      },
    ],
  },
)
