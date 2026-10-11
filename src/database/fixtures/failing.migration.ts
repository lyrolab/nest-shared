import { MigrationInterface } from "typeorm"

export class FailingSchema1700000000001 implements MigrationInterface {
  up(): Promise<void> {
    return Promise.reject(new Error("intentional migration failure"))
  }
  down(): Promise<void> {
    return Promise.resolve()
  }
}
