import {
  Column,
  Entity,
  EntitySchema,
  JoinTable,
  ManyToMany,
  PrimaryGeneratedColumn,
} from "typeorm"

@Entity({ name: 'person"record', schema: "fixtures" })
export class Person {
  @PrimaryGeneratedColumn()
  id!: number

  @Column()
  name!: string

  @ManyToMany(() => Tag, (tag) => tag.people, { cascade: true })
  @JoinTable({ name: "person_tags" })
  tags!: Tag[]
}

@Entity({ name: "tag", schema: "fixtures" })
export class Tag {
  @PrimaryGeneratedColumn()
  id!: number

  @Column()
  name!: string

  @ManyToMany(() => Person, (person) => person.tags)
  people!: Person[]
}

export const Note = new EntitySchema<{ id: number; text: string }>({
  name: "Note",
  tableName: "note",
  columns: {
    id: { type: Number, primary: true, generated: true },
    text: { type: String },
  },
})
