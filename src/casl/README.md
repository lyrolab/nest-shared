# CASL Module — `@lyrolab/nest-shared/casl`

Building blocks for [nest-casl](https://github.com/getjerry/nest-casl) permissions backed by TypeORM entities.

## What Is This?

- `BaseHook` — an abstract `SubjectBeforeFilterHook` that loads the subject of a `@UseAbility()` check from a route param.
- `getAbilityFactory()` — a test helper that builds nest-casl's `AbilityFactory` for a permissions object, so permission rules can be unit tested without booting the app.

## How Do I Use It?

### Subject hooks

Extend `BaseHook` with the entity and the route param holding its id. Set `relations` when the permission rules read related entities.

```typescript
import { Injectable } from "@nestjs/common"
import { BaseHook } from "@lyrolab/nest-shared/casl"
import { Board } from "src/modules/board/entities/board.entity"

@Injectable()
export class BoardHook extends BaseHook<Board> {
  entity = Board
  param = "boardId"
  relations = ["organization"]
}
```

```typescript
@Get(":boardId")
@UseGuards(AccessGuard)
@UseAbility(Actions.read, Board, BoardHook)
findOne(@Param("boardId", ParseUUIDPipe) boardId: string) {}
```

`run()` resolves the entity's repository through `ModuleRef` (non-strict), then:

| Situation                   | Result                                  |
| --------------------------- | --------------------------------------- |
| Param missing or not a UUID | `NotFoundException`, no query is issued |
| No row matches the id       | `NotFoundException`                     |
| Row found                   | The entity, loaded with `relations`     |

The UUID check matters because guards run before pipes: `ParseUUIDPipe` on the route has not validated the param yet when the hook queries the database.

### Testing permissions

```typescript
import { Actions } from "nest-casl"
import { getAbilityFactory } from "@lyrolab/nest-shared/casl"
import { boardPermissions } from "src/modules/board/permissions/board.permissions"

it("lets members read their organization's boards", async () => {
  const abilityFactory = await getAbilityFactory(boardPermissions)
  const ability = abilityFactory.createForUser(
    new CaslUser("user-1", ["org-1"]),
  )

  expect(ability.can(Actions.read, board)).toBe(true)
})
```

`getAbilityFactory` accepts any `Permissions<Roles>` object, including apps without roles (`Permissions<never>`).

## Requirements

- Peer dependencies: `nest-casl`, `@nestjs/core`, `@nestjs/typeorm`, `typeorm`, `class-validator`; `@nestjs/testing` for `getAbilityFactory`.
- Entities must have a UUID `id` column, and their repositories must be registered (e.g., `TypeOrmModule.forFeature([Board])`).

## Related Modules

- [Database](../database/README.md) — TypeORM connection the hooks query
- [Auth](../auth/README.md) — authenticates the user that abilities are built for
