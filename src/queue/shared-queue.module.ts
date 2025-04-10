import { BullModule } from "@nestjs/bullmq"
import { Module } from "@nestjs/common"
import { DiscoveryModule } from "@nestjs/core"
import { QueueProcessor } from "./processors/queue.processor"
import { DEFAULT_QUEUE } from "./queue.constants"
import { QueueService } from "./services/queue.service"
import { QueueController } from "./controllers/queue.controller"
@Module({
  imports: [BullModule.registerQueue({ name: DEFAULT_QUEUE }), DiscoveryModule],
  providers: [QueueService, QueueProcessor],
  exports: [QueueService],
  controllers: [QueueController],
})
export class SharedQueueModule {}
