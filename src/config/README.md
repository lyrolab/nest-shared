# Config Module — `@lyrolab/nest-shared/config`

Fail-fast environment validation with `class-validator` classes, for `@nestjs/config`.

## What Is This?

- **`validateEnv(Class)`** — returns a validator that converts the raw environment into an instance of `Class` (with implicit type conversion), strips undeclared variables and throws on any missing or invalid variable.
- **`registerConfig(Class)`** — a `registerAs` config factory, namespaced under the class name, that validates `process.env` against `Class` when the config is loaded.

Error messages list each failing variable with its constraint messages; received values are never included, so a malformed secret is not logged.

## Dependencies

```bash
npm install @nestjs/config class-validator class-transformer
```

## How Do I Use It?

Declare the variables a feature needs as a class:

```typescript
// src/payment/config/stripe.config.ts
import { IsString, IsUrl } from "class-validator"

export class StripeConfig {
  @IsString()
  STRIPE_SECRET_KEY!: string

  @IsUrl()
  STRIPE_WEBHOOK_URL!: string
}
```

### Validate the whole environment at boot

```typescript
import { ConfigModule } from "@nestjs/config"
import { validateEnv } from "@lyrolab/nest-shared/config"
import { EnvironmentVariables } from "./config/environment-variables"

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv(EnvironmentVariables),
    }),
  ],
})
export class AppModule {}
```

### Register a namespaced, typed config

```typescript
import { ConfigModule, ConfigType } from "@nestjs/config"
import { registerConfig } from "@lyrolab/nest-shared/config"

export const stripeConfig = registerConfig(StripeConfig)

@Module({ imports: [ConfigModule.forFeature(stripeConfig)] })
export class PaymentModule {}

@Injectable()
export class StripeService {
  constructor(
    @Inject(stripeConfig.KEY)
    private readonly config: ConfigType<typeof stripeConfig>,
  ) {}
}
```

Values are converted from strings using the declared property types. Implicit conversion turns any non-empty string, including `"false"`, into `true`, so parse booleans with `@Transform(({ obj, key }) => obj[key] === "true")` from `class-transformer`.

## Related Modules

- [Bootstrap](../bootstrap/README.md) — reads `CORS_ORIGINS`, `FRONTEND_URL` and `PORT`
