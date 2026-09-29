import { Controller, Get, INestApplication, Module, Req } from "@nestjs/common"
import { APP_GUARD } from "@nestjs/core"
import { Test } from "@nestjs/testing"
import * as crypto from "crypto"
import * as http from "http"
import * as jwt from "jsonwebtoken"
import * as request from "supertest"
import { Public } from "./decorators/public.decorator"
import { Roles } from "./decorators/roles.decorator"
import { JwtAuthGuard } from "./guards/jwt-auth.guard"
import { RolesGuard } from "./guards/roles.guard"
import { createUserProvisioningGuard } from "./guards/user-provisioning.guard"
import {
  ProvisioningIdentity,
  UserProvisioner,
} from "./interfaces/user-provisioner.interface"
import { SharedAuthModule } from "./shared-auth.module"

interface Idp {
  privateKey: crypto.KeyObject
  jwksUri: string
  server: http.Server
}

const startIdp = (kid: string): Promise<Idp> => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  })
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256" }
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ keys: [jwk] }))
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      resolve({
        privateKey,
        server,
        jwksUri: `http://127.0.0.1:${port}/certs`,
      })
    })
  })
}

const ISS_A = "https://idp-a.example.com/realms/acme"
const ISS_B = "https://idp-b.example.com/realms/globex"

class LocalUserProvisioner implements UserProvisioner<{ id: string }> {
  private readonly users = new Map<string, { id: string }>()

  provision({ issuer, subject }: ProvisioningIdentity) {
    const key = JSON.stringify([issuer, subject])
    let user = this.users.get(key)
    if (!user) {
      user = { id: `local-${this.users.size + 1}` }
      this.users.set(key, user)
    }
    return Promise.resolve(user)
  }
}

@Controller()
class TestController {
  @Get("me")
  me(@Req() req: { dbUser: { id: string } }) {
    return req.dbUser
  }

  @Roles("admin")
  @Get("admin")
  admin() {
    return { ok: true }
  }

  @Public()
  @Get("public")
  public(@Req() req: { dbUser?: unknown }) {
    return { provisioned: req.dbUser !== undefined }
  }
}

describe("SharedAuthModule with roles and provisioning (e2e)", () => {
  let app: INestApplication
  let server: http.Server
  let idpA: Idp
  let idpB: Idp

  const sign = (
    idp: Idp,
    kid: string,
    issuer: string,
    claims: Record<string, unknown> = {},
  ) =>
    jwt.sign({ sub: "same-sub", ...claims }, idp.privateKey, {
      algorithm: "RS256",
      keyid: kid,
      issuer,
      audience: "app",
      expiresIn: "5m",
    })

  beforeAll(async () => {
    idpA = await startIdp("kid-A")
    idpB = await startIdp("kid-B")

    @Module({
      imports: [
        SharedAuthModule.forRoot({
          resolveIssuer: (iss) => {
            if (iss === ISS_A) {
              return {
                jwksUri: idpA.jwksUri,
                audience: "app",
                trustRoles: true,
                clientId: "app",
              }
            }
            if (iss === ISS_B) return { jwksUri: idpB.jwksUri, audience: "app" }
            return null
          },
        }),
      ],
      controllers: [TestController],
      providers: [
        LocalUserProvisioner,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        {
          provide: APP_GUARD,
          useClass: createUserProvisioningGuard({
            provisioner: LocalUserProvisioner,
          }),
        },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
    class AppModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    server = app.getHttpServer() as http.Server
  })

  afterAll(async () => {
    await app.close()
    idpA.server.close()
    idpB.server.close()
  })

  it("provisions distinct local users for the same subject from two issuers", async () => {
    const tokenA = sign(idpA, "kid-A", ISS_A)
    const tokenB = sign(idpB, "kid-B", ISS_B)

    const a1 = await request(server)
      .get("/me")
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(200)
    const b = await request(server)
      .get("/me")
      .set("Authorization", `Bearer ${tokenB}`)
      .expect(200)
    const a2 = await request(server)
      .get("/me")
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(200)

    const idOf = (response: request.Response) =>
      (response.body as { id: string }).id
    expect(idOf(a1)).not.toBe(idOf(b))
    expect(idOf(a2)).toBe(idOf(a1))
  })

  it("grants a role-protected route to a trusted issuer's admin", async () => {
    const token = sign(idpA, "kid-A", ISS_A, {
      resource_access: { app: { roles: ["admin"] } },
    })
    await request(server)
      .get("/admin")
      .set("Authorization", `Bearer ${token}`)
      .expect(200)
  })

  it("forbids a role-protected route without the role", async () => {
    const token = sign(idpA, "kid-A", ISS_A, {
      realm_access: { roles: ["user"] },
    })
    await request(server)
      .get("/admin")
      .set("Authorization", `Bearer ${token}`)
      .expect(403)
  })

  it("ignores admin roles minted by an issuer not trusted for roles", async () => {
    const token = sign(idpB, "kid-B", ISS_B, {
      realm_access: { roles: ["admin"] },
      resource_access: { app: { roles: ["admin"] } },
    })
    await request(server)
      .get("/admin")
      .set("Authorization", `Bearer ${token}`)
      .expect(403)
  })

  it("rejects unauthenticated requests before provisioning", async () => {
    await request(server).get("/me").expect(401)
  })

  it("leaves public routes unprovisioned", async () => {
    const response = await request(server).get("/public").expect(200)
    expect(response.body).toEqual({ provisioned: false })
  })
})
