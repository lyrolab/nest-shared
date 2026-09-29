import {
  Controller,
  ExecutionContext,
  ForbiddenException,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { Roles } from "../decorators/roles.decorator"
import { AuthUser } from "../models/jwt-payload"
import { RolesGuard } from "./roles.guard"

@Controller()
class RolesController {
  open() {}

  @Roles("admin", "editor")
  restricted() {}
}

@Roles("admin")
@Controller()
class AdminController {
  inherited() {}

  @Roles("viewer")
  overridden() {}
}

const contextFor = (
  controller: object,
  handler: (...args: unknown[]) => unknown,
  user?: AuthUser,
): ExecutionContext =>
  ({
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext

const withRoles = (...roles: string[]): AuthUser => ({ id: "u", roles })

describe("RolesGuard", () => {
  const guard = new RolesGuard(new Reflector())
  const rolesProto = RolesController.prototype
  const adminProto = AdminController.prototype

  it("allows routes without @Roles()", () => {
    expect(
      guard.canActivate(contextFor(RolesController, rolesProto.open)),
    ).toBe(true)
  })

  it("allows a user holding any of the required roles", () => {
    expect(
      guard.canActivate(
        contextFor(RolesController, rolesProto.restricted, withRoles("editor")),
      ),
    ).toBe(true)
  })

  it("forbids a user holding none of the required roles", () => {
    expect(() =>
      guard.canActivate(
        contextFor(RolesController, rolesProto.restricted, withRoles("user")),
      ),
    ).toThrow(ForbiddenException)
  })

  it("forbids a user without roles", () => {
    expect(() =>
      guard.canActivate(
        contextFor(RolesController, rolesProto.restricted, { id: "u" }),
      ),
    ).toThrow(ForbiddenException)
  })

  it("forbids an unauthenticated request on a role-protected route", () => {
    expect(() =>
      guard.canActivate(contextFor(RolesController, rolesProto.restricted)),
    ).toThrow(ForbiddenException)
  })

  it("applies class-level roles to every handler", () => {
    expect(() =>
      guard.canActivate(
        contextFor(AdminController, adminProto.inherited, withRoles("viewer")),
      ),
    ).toThrow(ForbiddenException)
    expect(
      guard.canActivate(
        contextFor(AdminController, adminProto.inherited, withRoles("admin")),
      ),
    ).toBe(true)
  })

  it("lets handler-level roles override class-level roles", () => {
    expect(
      guard.canActivate(
        contextFor(AdminController, adminProto.overridden, withRoles("viewer")),
      ),
    ).toBe(true)
  })

  it("matches roles exactly", () => {
    expect(() =>
      guard.canActivate(
        contextFor(
          RolesController,
          rolesProto.restricted,
          withRoles("Admin", "admin-lite"),
        ),
      ),
    ).toThrow(ForbiddenException)
  })
})
