import { IsObject, IsOptional, IsString } from "class-validator"

export class QueueAddDto {
  @IsString()
  name: string

  @IsObject()
  @IsOptional()
  data?: Record<string, any>
}
