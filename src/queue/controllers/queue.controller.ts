import { Body, Controller, Post } from "@nestjs/common"
import { QueueService } from "../services/queue.service"
import { QueueAddDto } from "../models/dto/queue-add.dto"

@Controller("queue")
export class QueueController {
  constructor(private readonly queueService: QueueService) {}

  @Post("add")
  async add(@Body() body: QueueAddDto) {
    return this.queueService.add(body.name, body.data)
  }
}
