import { Actions, Permissions } from "nest-casl"
import { getAbilityFactory } from "./get-ability-factory"

enum Roles {
  admin = "admin",
}

class Customer {
  constructor(public tenantId: string) {}
}

class User {
  constructor(
    public id: string,
    public roles: Roles[] = [],
  ) {}
}

const permissions: Permissions<Roles> = {
  everyone({ can, user }) {
    can(Actions.update, Customer, { tenantId: user.id })
  },
  admin({ can }) {
    can(Actions.manage, "all")
  },
}

describe("getAbilityFactory", () => {
  it("builds abilities from the given permissions", async () => {
    const abilityFactory = await getAbilityFactory(permissions)
    const ability = abilityFactory.createForUser(new User("123"))

    expect(ability.can(Actions.update, new Customer("123"))).toBe(true)
    expect(ability.can(Actions.update, new Customer("456"))).toBe(false)
  })

  it("applies role permissions", async () => {
    const abilityFactory = await getAbilityFactory(permissions)
    const ability = abilityFactory.createForUser(new User("123", [Roles.admin]))

    expect(ability.can(Actions.delete, new Customer("456"))).toBe(true)
  })
})
