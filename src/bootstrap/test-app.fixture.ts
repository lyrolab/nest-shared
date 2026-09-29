import { Body, Controller, Get, Module, Post } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { ApiProperty } from "@nestjs/swagger"
import { IsString } from "class-validator"

export class GreetingDto {
  @ApiProperty()
  @IsString()
  name!: string
}

@Controller("greetings")
export class GreetingController {
  @Get()
  list(): string[] {
    return ["hello"]
  }

  @Post()
  create(@Body() dto: GreetingDto): GreetingDto {
    return dto
  }
}

export const EXPLODING_PROVIDER = "EXPLODING_PROVIDER"

@Module({
  imports: [ConfigModule.forRoot({ ignoreEnvFile: true })],
  controllers: [GreetingController],
})
export class TestAppModule {}

@Module({
  controllers: [GreetingController],
  providers: [
    {
      provide: EXPLODING_PROVIDER,
      useFactory: () => {
        throw new Error("provider must not be instantiated")
      },
    },
  ],
})
export class ExplodingAppModule {}
