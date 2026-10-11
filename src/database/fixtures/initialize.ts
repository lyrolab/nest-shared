import { SharedDatabaseModule, TestDatabaseInvocation } from "../index"

declare global {
  const invocation: TestDatabaseInvocation
}

SharedDatabaseModule.initializeTestInvocation(invocation)
