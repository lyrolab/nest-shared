import { NotFoundException } from "@nestjs/common"
import { ModuleRef } from "@nestjs/core"
import { randomUUID } from "crypto"
import { Request } from "express"
import { Repository } from "typeorm"
import { BaseHook } from "./base.hook"

class Board {
  id: string
}

class TestHook extends BaseHook<Board> {
  entity = Board
  param = "boardId"
  relations = ["tags", "context"]
}

class HookWithoutRelations extends BaseHook<Board> {
  entity = Board
  param = "boardId"
}

describe("BaseHook", () => {
  let repository: { findOne: jest.Mock }
  let moduleRef: ModuleRef
  let hook: TestHook

  beforeEach(() => {
    repository = { findOne: jest.fn() }
    moduleRef = {
      get: jest
        .fn()
        .mockReturnValue(repository as unknown as Repository<Board>),
    } as unknown as ModuleRef
    hook = new TestHook(moduleRef)
  })

  const requestWithParams = (params: Record<string, string>) =>
    ({ params }) as unknown as Request

  it.each([
    ["missing", {}],
    ["not a UUID", { boardId: "not-a-uuid" }],
  ])(
    "throws NotFoundException without querying when the param is %s",
    async (_label, params) => {
      await expect(hook.run(requestWithParams(params))).rejects.toBeInstanceOf(
        NotFoundException,
      )
      expect(repository.findOne).not.toHaveBeenCalled()
    },
  )

  it("throws NotFoundException when no entity matches the id", async () => {
    repository.findOne.mockResolvedValue(null)

    await expect(
      hook.run(requestWithParams({ boardId: randomUUID() })),
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  it("returns the entity queried by the configured param and relations", async () => {
    const boardId = randomUUID()
    const board = { id: boardId }
    repository.findOne.mockResolvedValue(board)

    const result = await hook.run(requestWithParams({ boardId }))

    expect(result).toBe(board)
    expect(moduleRef.get).toHaveBeenCalledWith("BoardRepository", {
      strict: false,
    })
    expect(repository.findOne).toHaveBeenCalledWith({
      where: { id: boardId },
      relations: ["tags", "context"],
    })
  })

  it("loads no relations by default", async () => {
    const boardId = randomUUID()
    repository.findOne.mockResolvedValue({ id: boardId })

    await new HookWithoutRelations(moduleRef).run(
      requestWithParams({ boardId }),
    )

    expect(repository.findOne).toHaveBeenCalledWith({
      where: { id: boardId },
      relations: [],
    })
  })
})
