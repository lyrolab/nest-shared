import { createParamDecorator, ExecutionContext } from "@nestjs/common"
import { Request } from "express"
import { AuthUser } from "../models/jwt-payload"

export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { user: AuthUser }>()
    return request.user
  },
)
