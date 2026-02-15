import { Inject, Injectable } from "@nestjs/common"
import { PassportStrategy } from "@nestjs/passport"
import { ExtractJwt, Strategy } from "passport-jwt"
import { passportJwtSecret } from "jwks-rsa"
import { AUTH_MODULE_OPTIONS } from "../auth.constants"
import { AuthModuleOptions } from "../interfaces/auth-module-options.interface"
import { AuthUser, JwtPayload } from "../models/jwt-payload"

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(@Inject(AUTH_MODULE_OPTIONS) options: AuthModuleOptions) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: options.jwksUri,
      }),
      issuer: options.issuer,
    })
  }

  validate(payload: JwtPayload): AuthUser {
    return {
      id: payload.sub,
      email: payload.email,
      name: payload.preferred_username,
    }
  }
}
