import * as crypto from "crypto"
import * as http from "http"
import * as jwt from "jsonwebtoken"
import { JwtStrategy } from "./jwt.strategy"
import {
  DynamicAuthOptions,
  StaticAuthOptions,
} from "../interfaces/auth-module-options.interface"

// Two independent "IdPs", each with its own RSA keypair served over a live JWKS
// endpoint — the same setup the BOA-29 spike proved, ported into jest.

interface Idp {
  kid: string
  publicKey: crypto.KeyObject
  privateKey: crypto.KeyObject
  jwk: crypto.JsonWebKey & { kid: string; use: string; alg: string }
}

const makeIdp = (kid: string): Idp => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  })
  return {
    kid,
    publicKey,
    privateKey,
    jwk: {
      ...publicKey.export({ format: "jwk" }),
      kid,
      use: "sig",
      alg: "RS256",
    },
  }
}

const startJwks = (
  idp: Idp,
): Promise<{ server: http.Server; jwksUri: string }> =>
  new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ keys: [idp.jwk] }))
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      resolve({ server, jwksUri: `http://127.0.0.1:${port}/certs` })
    })
  })

const sign = (
  idp: Idp,
  issuer: string,
  claims: Record<string, unknown> = {},
  options: jwt.SignOptions = {},
): string =>
  jwt.sign(
    { sub: "user-1", email: "u@example.com", ...claims },
    idp.privateKey,
    {
      algorithm: "RS256",
      keyid: idp.kid,
      issuer,
      expiresIn: "5m",
      ...options,
    },
  )

type Outcome =
  | { result: "success"; user: unknown }
  | { result: "fail"; info: unknown }
  | { result: "error"; error: unknown }

// Drive the strategy exactly as @nestjs/passport's AuthGuard('jwt') does. `fail`
// maps to a 401, `error` to a 500 — the distinction lets us assert error→401.
const authenticate = (strategy: JwtStrategy, token: string): Promise<Outcome> =>
  new Promise((resolve) => {
    const req = { headers: { authorization: `Bearer ${token}` } }
    const driver = Object.create(strategy) as {
      success: (user: unknown) => void
      fail: (info: unknown) => void
      error: (error: unknown) => void
      redirect: () => void
      pass: () => void
      authenticate: (req: unknown) => void
    }
    driver.success = (user: unknown) => resolve({ result: "success", user })
    driver.fail = (info: unknown) => resolve({ result: "fail", info })
    driver.error = (error: unknown) => resolve({ result: "error", error })
    driver.redirect = () => resolve({ result: "fail", info: "redirect" })
    driver.pass = () => resolve({ result: "fail", info: "pass" })
    driver.authenticate(req)
  })

const ISS_A = "https://idp-a.example.com/realms/acme"
const ISS_B = "https://idp-b.example.com/realms/globex"
const ISS_UNKNOWN = "https://evil.example.com/realms/x"

describe("JwtStrategy", () => {
  let idpA: Idp
  let idpB: Idp
  let idpEvil: Idp // reuses A's kid but a different key
  let idpForgeB: Idp // reuses B's kid but a different key
  let jwksA: { server: http.Server; jwksUri: string }
  let jwksB: { server: http.Server; jwksUri: string }

  beforeAll(async () => {
    idpA = makeIdp("kid-A")
    idpB = makeIdp("kid-B")
    idpEvil = makeIdp("kid-A")
    idpForgeB = makeIdp("kid-B")
    jwksA = await startJwks(idpA)
    jwksB = await startJwks(idpB)
  })

  afterAll(() => {
    jwksA.server.close()
    jwksB.server.close()
  })

  describe("dynamic multi-issuer mode", () => {
    let strategy: JwtStrategy
    let resolveCalls: number

    beforeAll(() => {
      const registry: Record<string, { jwksUri: string }> = {
        [ISS_A]: { jwksUri: jwksA.jwksUri },
        [ISS_B]: { jwksUri: jwksB.jwksUri },
      }
      const options: DynamicAuthOptions = {
        resolveIssuer: (iss) => {
          resolveCalls++
          return registry[iss] ?? null
        },
      }
      strategy = new JwtStrategy(options)
    })

    beforeEach(() => {
      resolveCalls = 0
    })

    it("accepts a valid token from issuer A", async () => {
      const outcome = await authenticate(strategy, sign(idpA, ISS_A))
      expect(outcome.result).toBe("success")
    })

    it("accepts a valid token from issuer B on the same strategy instance", async () => {
      const outcome = await authenticate(strategy, sign(idpB, ISS_B))
      expect(outcome.result).toBe("success")
    })

    it("rejects an unknown issuer as an auth failure, not a server error", async () => {
      const outcome = await authenticate(strategy, sign(idpA, ISS_UNKNOWN))
      // fail => 401, never error => 500. This is the error→401 mapping guarantee.
      expect(outcome.result).toBe("fail")
    })

    it("rejects a token claiming a trusted iss but signed with the wrong key", async () => {
      const outcome = await authenticate(strategy, sign(idpEvil, ISS_B))
      expect(outcome.result).toBe("fail")
    })

    it("rejects a forged token reusing the real kid with a different private key", async () => {
      const outcome = await authenticate(strategy, sign(idpForgeB, ISS_B))
      expect(outcome.result).toBe("fail")
    })

    it("rejects a cross-issuer token (A's key claiming iss=B)", async () => {
      const outcome = await authenticate(strategy, sign(idpA, ISS_B))
      expect(outcome.result).toBe("fail")
    })

    it("rejects an expired token", async () => {
      const outcome = await authenticate(
        strategy,
        sign(idpA, ISS_A, {}, { expiresIn: -10 }),
      )
      expect(outcome.result).toBe("fail")
    })

    it("rejects a token with an unknown kid", async () => {
      const outcome = await authenticate(
        strategy,
        sign(idpA, ISS_A, {}, { keyid: "kid-NOPE" }),
      )
      expect(outcome.result).toBe("fail")
    })

    it("consults the resolver exactly once per request", async () => {
      await authenticate(strategy, sign(idpA, ISS_A))
      expect(resolveCalls).toBe(1)
    })

    it("rejects a resolver failure as an auth failure, not a server error", async () => {
      const options: DynamicAuthOptions = {
        resolveIssuer: () => Promise.reject(new Error("db down")),
      }
      const throwingStrategy = new JwtStrategy(options)
      const outcome = await authenticate(throwingStrategy, sign(idpA, ISS_A))
      expect(outcome.result).toBe("fail")
    })

    it("rejects an HS256 token forged with the RSA public key as the HMAC secret", async () => {
      const publicPem = idpA.publicKey
        .export({ type: "spki", format: "pem" })
        .toString()
      const forged = jwt.sign({ sub: "user-1" }, publicPem, {
        algorithm: "HS256",
        keyid: "kid-A",
        issuer: ISS_A,
        expiresIn: "5m",
      })
      const outcome = await authenticate(strategy, forged)
      expect(outcome.result).toBe("fail")
    })

    it("rejects an unsigned (alg: none) token", async () => {
      const header = Buffer.from(
        JSON.stringify({ alg: "none", kid: "kid-A", typ: "JWT" }),
      ).toString("base64url")
      const payload = Buffer.from(
        JSON.stringify({
          sub: "user-1",
          iss: ISS_A,
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      ).toString("base64url")
      const outcome = await authenticate(strategy, `${header}.${payload}.`)
      expect(outcome.result).toBe("fail")
    })
  })

  describe("audience validation", () => {
    let strategy: JwtStrategy

    beforeAll(() => {
      const options: DynamicAuthOptions = {
        resolveIssuer: (iss) =>
          iss === ISS_A
            ? { jwksUri: jwksA.jwksUri, audience: "boardbot" }
            : null,
      }
      strategy = new JwtStrategy(options)
    })

    it("accepts a token with the expected audience", async () => {
      const outcome = await authenticate(
        strategy,
        sign(idpA, ISS_A, { aud: "boardbot" }),
      )
      expect(outcome.result).toBe("success")
    })

    it("rejects a token minted for another audience", async () => {
      const outcome = await authenticate(
        strategy,
        sign(idpA, ISS_A, { aud: "other-client" }),
      )
      expect(outcome.result).toBe("fail")
    })

    it("rejects a token with no audience when one is required", async () => {
      const outcome = await authenticate(strategy, sign(idpA, ISS_A))
      expect(outcome.result).toBe("fail")
    })
  })

  describe("static single-issuer mode (back-compat)", () => {
    let strategy: JwtStrategy

    beforeAll(() => {
      const options: StaticAuthOptions = {
        jwksUri: jwksA.jwksUri,
        issuer: ISS_A,
      }
      strategy = new JwtStrategy(options)
    })

    it("accepts a valid token from the configured issuer", async () => {
      const outcome = await authenticate(strategy, sign(idpA, ISS_A))
      expect(outcome.result).toBe("success")
    })

    it("rejects a token from a different issuer", async () => {
      const outcome = await authenticate(strategy, sign(idpA, ISS_B))
      expect(outcome.result).toBe("fail")
    })

    it("rejects a token signed by a foreign key", async () => {
      const outcome = await authenticate(strategy, sign(idpB, ISS_A))
      expect(outcome.result).toBe("fail")
    })

    it("rejects an HS256 token forged with the RSA public key as the HMAC secret", async () => {
      const publicPem = idpA.publicKey
        .export({ type: "spki", format: "pem" })
        .toString()
      const forged = jwt.sign({ sub: "user-1" }, publicPem, {
        algorithm: "HS256",
        issuer: ISS_A,
        expiresIn: "5m",
      })
      const outcome = await authenticate(strategy, forged)
      expect(outcome.result).toBe("fail")
    })
  })
})
