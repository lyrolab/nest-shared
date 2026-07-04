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

    // Allow the health-check endpoint, which lives in an external module we
    // can't decorate with @Public(). This is an exact match on a single known
    // unauthenticated endpoint (k8s liveness/readiness probe) — never a prefix.
    //
    // NOTE: there used to be a `request.path.startsWith("/api")` branch here to
    // expose Swagger docs. It was a security hole: it skipped JWT auth for every
    // route under /api. It is also unnecessary — SwaggerModule.setup() registers
    // its routes directly on the Express adapter, outside the Nest request
    // lifecycle, so this guard never runs on them. Removed. Everything that must
    // be public now goes through @Public() (or this narrow /health exception).
    const request = context.switchToHttp().getRequest<Request>()
    if (request.path === "/health") return true

    return super.canActivate(context)
  }
}
