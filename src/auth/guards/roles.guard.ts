import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { Request } from "express"
import { ROLES_KEY } from "../decorators/roles.decorator"
import { AuthUser } from "../models/jwt-payload"

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    )
    if (required === undefined) return true

    const { user } = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthUser }>()
    const granted = user?.roles ?? []
    if (required.length > 0 && required.some((role) => granted.includes(role)))
      return true

    throw new ForbiddenException()
  }
}
