import { registerAs } from "@nestjs/config"
import { ClassConstructor, plainToInstance } from "class-transformer"
import { validateSync, ValidationError } from "class-validator"

export function validateEnv<T extends object>(
  envClass: ClassConstructor<T>,
): (config: Record<string, unknown>) => T {
  return (config) => {
    const validated = plainToInstance(envClass, config, {
      enableImplicitConversion: true,
    })
    const errors = validateSync(validated, {
      skipMissingProperties: false,
      whitelist: true,
    })
    if (errors.length > 0) {
      throw new Error(
        `Invalid environment configuration (${envClass.name}):\n${formatErrors(errors)}`,
      )
    }
    return validated
  }
}

export function registerConfig<T extends object>(
  envClass: ClassConstructor<T>,
) {
  return registerAs(envClass.name, () =>
    validateEnv(envClass)(process.env as Record<string, unknown>),
  )
}

// Built from property names and constraint messages only, never the received
// value, so a malformed secret is not echoed into logs.
const formatErrors = (errors: ValidationError[]) =>
  errors
    .map(
      (error) =>
        `  - ${error.property}: ${Object.values(error.constraints ?? {}).join(", ")}`,
    )
    .join("\n")
