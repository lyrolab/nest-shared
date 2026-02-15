import { ExecutionContext, Injectable } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { AuthGuard } from "@nestjs/passport"
import { Request } from "express"
import { IS_PUBLIC_KEY } from "../decorators/public.decorator"

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor(private reflector: Reflector) {
    super()
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (isPublic) return true

    // Allow health and API docs endpoints (from external modules we can't decorate)
    const request = context.switchToHttp().getRequest<Request>()
    if (request.path === "/health" || request.path.startsWith("/api"))
      return true

    return super.canActivate(context)
  }
}
