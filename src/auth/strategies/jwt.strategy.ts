import { Inject, Injectable } from "@nestjs/common"
import { PassportStrategy } from "@nestjs/passport"
import { Request } from "express"
import { Algorithm, decode, JwtPayload as SignedJwtPayload } from "jsonwebtoken"
import { JwksClient, passportJwtSecret, SigningKey } from "jwks-rsa"
import { ExtractJwt, SecretOrKeyProvider, Strategy } from "passport-jwt"
import { AUTH_MODULE_OPTIONS } from "../auth.constants"
import {
  AuthModuleOptions,
  DynamicAuthOptions,
  isDynamicAuthOptions,
  ResolvedIssuer,
} from "../interfaces/auth-module-options.interface"
import { AuthUser, JwtPayload } from "../models/jwt-payload"

// Pinning the algorithm allowlist closes the alg-confusion hole (`alg: none`, or an
// RS public key abused as an HS256 secret). Applied to both the static and dynamic
// paths.
const DEFAULT_ALGORITHMS: Algorithm[] = ["RS256"]

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly roleSource: (request: Request) => RoleSource | null

  constructor(@Inject(AUTH_MODULE_OPTIONS) options: AuthModuleOptions) {
    const algorithms = (options.algorithms ?? DEFAULT_ALGORITHMS) as Algorithm[]

    if (isDynamicAuthOptions(options)) {
      // The issuer config resolved while picking the signing key is reused in
      // validate() so roles are read under the same trust decision, without a
      // second resolver call.
      const resolved = new WeakMap<Request, ResolvedIssuer>()
      super({
        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        ignoreExpiration: false,
        algorithms,
        passReqToCallback: true,
        secretOrKeyProvider: JwtStrategy.dynamicSecretOrKeyProvider(
          options,
          resolved,
        ),
      })
      this.roleSource = (request) => {
        const config = resolved.get(request)
        return config?.trustRoles ? { clientId: config.clientId } : null
      }
    } else {
      super({
        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        ignoreExpiration: false,
        algorithms,
        passReqToCallback: true,
        issuer: options.issuer,
        audience: options.audience,
        secretOrKeyProvider: passportJwtSecret({
          cache: true,
          rateLimit: true,
          jwksRequestsPerMinute: 5,
          jwksUri: options.jwksUri,
        }),
      })
      this.roleSource = () => ({ clientId: options.clientId })
    }
  }

  validate(request: Request, payload: JwtPayload): AuthUser {
    const roleSource = this.roleSource(request)
    return {
      id: payload.sub,
      email: payload.email,
      name: payload.preferred_username,
      issuer: payload.iss,
      roles: roleSource ? extractRoles(payload, roleSource.clientId) : [],
    }
  }

  /**
   * Resolves the signing key for a token by routing on its `iss`. The token is
   * decoded unverified only to read routing claims (`iss`, `kid`) and to reject on a
   * mismatched audience — never to accept it. Acceptance is still gated by verifying
   * the signature against the resolved issuer's JWKS, so a forged `iss`/`aud` buys
   * nothing.
   *
   * Every failure path calls `done(error)`, which passport-jwt surfaces as an auth
   * failure (401), not an error (500), and the issuer-internal reason never reaches
   * the client.
   */
  private static dynamicSecretOrKeyProvider(
    options: DynamicAuthOptions,
    resolved: WeakMap<Request, ResolvedIssuer>,
  ): SecretOrKeyProvider {
    // One cached JwksClient per issuer, mirroring passportJwtSecret's posture. The
    // strategy is a singleton, so this Map lives for the process and refreshes keys
    // on `kid` rotation.
    const clients = new Map<string, JwksClient>()

    return (request: Request, rawJwt: string, done) => {
      const decoded = decode(rawJwt, { complete: true })
      const payload = decoded?.payload
      if (!decoded || typeof payload !== "object") {
        return done(new Error("malformed token"))
      }

      const iss = payload.iss
      const kid = decoded.header.kid
      if (typeof iss !== "string" || iss.length === 0) {
        return done(new Error("missing iss"))
      }

      Promise.resolve(options.resolveIssuer(iss))
        .then((config) => {
          if (!config) {
            return done(new Error("untrusted issuer"))
          }
          if (!audienceMatches(config.audience, payload)) {
            return done(new Error("audience mismatch"))
          }
          resolved.set(request, config)

          let client = clients.get(iss)
          if (!client) {
            client = new JwksClient({
              jwksUri: config.jwksUri,
              cache: true,
              rateLimit: true,
            })
            clients.set(iss, client)
          }

          client.getSigningKey(kid, (error: Error | null, key?: SigningKey) => {
            if (error || !key) {
              return done(error ?? new Error("signing key not found"))
            }
            done(null, key.getPublicKey())
          })
        })
        // Fail closed: a resolver throw or a slow/down JWKS endpoint rejects the
        // token instead of wedging the request.
        .catch(() => done(new Error("issuer resolution failed")))
    }
  }
}

interface RoleSource {
  clientId?: string
}

function extractRoles(payload: JwtPayload, clientId?: string): string[] {
  const realmRoles = payload.realm_access?.roles
  const clientAccess =
    clientId &&
    payload.resource_access &&
    Object.hasOwn(payload.resource_access, clientId)
      ? payload.resource_access[clientId]
      : undefined
  const clientRoles = clientAccess?.roles
  const roles = [
    ...(Array.isArray(realmRoles) ? realmRoles : []),
    ...(Array.isArray(clientRoles) ? clientRoles : []),
  ].filter((role): role is string => typeof role === "string")
  return [...new Set(roles)]
}

function audienceMatches(
  expected: string | string[] | undefined,
  payload: SignedJwtPayload,
): boolean {
  if (expected === undefined) {
    return true
  }
  const expectedList = Array.isArray(expected) ? expected : [expected]
  const claim = payload.aud
  const claimList =
    claim === undefined ? [] : Array.isArray(claim) ? claim : [claim]
  return expectedList.some((value) => claimList.includes(value))
}
