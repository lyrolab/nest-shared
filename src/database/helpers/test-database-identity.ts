import { createHash } from "node:crypto"
import type { TestDatabaseInfo } from "../shared-database.module"

export function quoteIdentifier(identifier: string): string {
  if (!identifier || identifier.includes("\0"))
    throw new Error("Invalid database identifier")
  return `"${identifier.replaceAll('"', '""')}"`
}

export function testDatabaseName(
  baseName: string,
  identity: Pick<TestDatabaseInfo, "namespace" | "processId" | "workerId">,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        baseName,
        identity.namespace,
        identity.processId,
        identity.workerId,
      ]),
    )
    .digest("hex")
    .slice(0, 32)
  const suffix = `_test_${digest}`
  let prefix = ""
  for (const character of baseName) {
    if (Buffer.byteLength(prefix + character + suffix) > 63) break
    prefix += character
  }
  return prefix + suffix
}

export function testDatabaseLockKey(databaseName: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify(["@lyrolab/nest-shared/test-database", databaseName]),
    )
    .digest()
    .readBigInt64BE()
    .toString()
}
