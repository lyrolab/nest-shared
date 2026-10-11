import { MigrationInterface, QueryRunner } from "typeorm"

export class FixtureSchema1700000000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query("CREATE SCHEMA fixtures")
    await runner.query(
      'CREATE TABLE fixtures."person""record" (id SERIAL PRIMARY KEY, name varchar NOT NULL)',
    )
    await runner.query(
      "CREATE TABLE fixtures.tag (id SERIAL PRIMARY KEY, name varchar NOT NULL)",
    )
    await runner.query(
      'CREATE TABLE fixtures.person_tags ("personRecordId" integer REFERENCES fixtures."person""record"(id), "tagId" integer REFERENCES fixtures.tag(id), PRIMARY KEY ("personRecordId", "tagId"))',
    )
    await runner.query(
      "CREATE TABLE public.note (id SERIAL PRIMARY KEY, text varchar NOT NULL)",
    )
    await runner.query(
      "CREATE TABLE public.migration_only (id integer PRIMARY KEY)",
    )
    await runner.query("INSERT INTO public.migration_only VALUES (1)")
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query("DROP SCHEMA fixtures CASCADE")
    await runner.query("DROP TABLE public.note, public.migration_only")
  }
}

export class FailingSchema1700000000001 implements MigrationInterface {
  up(): Promise<void> {
    return Promise.reject(new Error("intentional migration failure"))
  }
  down(): Promise<void> {
    return Promise.resolve()
  }
}
