import { ExecutionContext } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { JwtAuthGuard } from "./jwt-auth.guard"

const basePrototype = Object.getPrototypeOf(JwtAuthGuard.prototype) as {
  canActivate: (context: ExecutionContext) => unknown
}

const SUPER_SENTINEL = Symbol("super.canActivate")

const createContext = (path: string): ExecutionContext =>
  ({
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({
      getRequest: () => ({ path }),
    }),
  }) as unknown as ExecutionContext

describe("JwtAuthGuard", () => {
  let guard: JwtAuthGuard
  let reflector: { getAllAndOverride: jest.Mock }
  let superSpy: jest.SpyInstance

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) }
    guard = new JwtAuthGuard(reflector as unknown as Reflector)
    superSpy = jest
      .spyOn(basePrototype, "canActivate")
      .mockReturnValue(SUPER_SENTINEL as never)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("allows @Public() routes without invoking JWT auth", () => {
    reflector.getAllAndOverride.mockReturnValue(true)

    expect(guard.canActivate(createContext("/boards"))).toBe(true)
    expect(superSpy).not.toHaveBeenCalled()
  })

  it("allows the exact /health probe without JWT auth", () => {
    expect(guard.canActivate(createContext("/health"))).toBe(true)
    expect(superSpy).not.toHaveBeenCalled()
  })

  it("requires JWT auth for /api routes (no path-prefix bypass)", () => {
    expect(guard.canActivate(createContext("/api/boards"))).toBe(SUPER_SENTINEL)
    expect(superSpy).toHaveBeenCalledTimes(1)
  })

  it("requires JWT auth for the /api docs root itself", () => {
    expect(guard.canActivate(createContext("/api"))).toBe(SUPER_SENTINEL)
    expect(superSpy).toHaveBeenCalledTimes(1)
  })

  it("requires JWT auth for ordinary protected routes", () => {
    expect(guard.canActivate(createContext("/boards"))).toBe(SUPER_SENTINEL)
    expect(superSpy).toHaveBeenCalledTimes(1)
  })

  it("does not treat /health-adjacent paths as public", () => {
    expect(guard.canActivate(createContext("/healthz"))).toBe(SUPER_SENTINEL)
    expect(superSpy).toHaveBeenCalledTimes(1)
  })
})
