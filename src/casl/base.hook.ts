import { Injectable, NotFoundException } from "@nestjs/common"
import { ModuleRef } from "@nestjs/core"
import { getRepositoryToken } from "@nestjs/typeorm"
import { isUUID } from "class-validator"
import { Request } from "express"
import { SubjectBeforeFilterHook } from "nest-casl"
import { FindOptionsWhere, ObjectLiteral, Repository } from "typeorm"

@Injectable()
export abstract class BaseHook<T extends ObjectLiteral & { id: string }>
  implements SubjectBeforeFilterHook<T, Request>
{
  abstract entity: new () => T
  abstract param: string
  relations: string[] = []

  constructor(private moduleRef: ModuleRef) {}

  async run(request: Request): Promise<T> {
    const repository = this.moduleRef.get<Repository<T>>(
      getRepositoryToken(this.entity),
      { strict: false },
    )
    const params = request.params as Record<string, string | undefined>
    const id = params[this.param]
    // Guards run before pipes, so a route's ParseUUIDPipe has not fired yet:
    // querying a non-UUID id here would surface as a driver error, not a 404.
    if (!isUUID(id)) {
      throw new NotFoundException()
    }
    const instance = await repository.findOne({
      where: { id } as FindOptionsWhere<T>,
      relations: this.relations,
    })

    if (!instance) {
      throw new NotFoundException()
    }

    return instance
  }
}
