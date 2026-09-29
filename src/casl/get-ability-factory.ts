import { Test } from "@nestjs/testing"
import { AnyPermissions } from "nest-casl"
import { AbilityFactory } from "nest-casl/dist/factories/ability.factory"

export async function getAbilityFactory<Roles extends string = string>(
  permissions: AnyPermissions<Roles, any, any, any>,
): Promise<AbilityFactory> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      AbilityFactory,
      { provide: "CASL_FEATURE_OPTIONS", useValue: { permissions } },
    ],
  }).compile()

  return moduleRef.get<AbilityFactory>(AbilityFactory)
}
