import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  NotFoundException,
  Logger,
} from "@nestjs/common"
import { Response } from "express"
import { EntityNotFoundError } from "typeorm"

@Catch(EntityNotFoundError)
export class TypeOrmExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(TypeOrmExceptionFilter.name)

  catch(exception: EntityNotFoundError, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const response = ctx.getResponse<Response>()

    this.logger.debug(`Original TypeORM error: ${exception.message}`)

    const entityName = this.extractEntityName(exception.message)
    const message = entityName ? `${entityName} not found` : "Entity not found"

    const notFoundException = new NotFoundException(message)

    response
      .status(notFoundException.getStatus())
      .json(notFoundException.getResponse())
  }

  private extractEntityName(errorMessage: string): string | null {
    const match = errorMessage.match(/entity of type "([^"]+)"/)
    return match ? match[1] : null
  }
}
