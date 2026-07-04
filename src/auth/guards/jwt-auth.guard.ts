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

    // /health is served by an external module we can't decorate with @Public();
    // allow it by exact path only, never a prefix.
    const request = context.switchToHttp().getRequest<Request>()
    if (request.path === "/health") return true

    return super.canActivate(context)
  }
}
