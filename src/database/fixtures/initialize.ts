import { SharedDatabaseModule, TestDatabaseInvocation } from "../index"

declare global {
  const invocation: TestDatabaseInvocation
}

SharedDatabaseModule.initializeTestInvocation(
  typeof invocation === "undefined" ? undefined : invocation,
)
