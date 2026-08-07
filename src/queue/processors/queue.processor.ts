import { InjectQueue, Processor } from "@nestjs/bullmq"
import { Inject, Injectable, Optional, SetMetadata } from "@nestjs/common"
import { Queue } from "bullmq"
import { QueueModuleOptions } from "../interfaces/queue-options.interface"
import { DEFAULT_QUEUE, QUEUE_MODULE_OPTIONS } from "../queue.constants"
import { JobRegistryService } from "../services/job-registry.service"
import { BaseQueueProcessor, buildWorkerMetadata } from "./base-queue.processor"

@Injectable()
@Processor(DEFAULT_QUEUE)
export class QueueProcessor extends BaseQueueProcessor {
  protected readonly queueName = DEFAULT_QUEUE

  constructor(
    registry: JobRegistryService,
    @InjectQueue(DEFAULT_QUEUE) queue: Queue,
    @Optional()
    @Inject(QUEUE_MODULE_OPTIONS)
    options?: QueueModuleOptions,
  ) {
    super(registry, queue)

    const workerMetadata = buildWorkerMetadata(
      options?.concurrency,
      options?.telemetry,
    )
    if (workerMetadata) {
      SetMetadata("bullmq:worker_metadata", workerMetadata)(QueueProcessor)
    }
  }
}
