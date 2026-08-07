import { InjectQueue, Processor } from "@nestjs/bullmq"
import { Inject, Injectable, Optional, SetMetadata, Type } from "@nestjs/common"
import { Queue } from "bullmq"
import {
  QueueDefinition,
  QueueModuleOptions,
} from "../interfaces/queue-options.interface"
import { QUEUE_MODULE_OPTIONS } from "../queue.constants"
import { JobRegistryService } from "../services/job-registry.service"
import { BaseQueueProcessor, buildWorkerMetadata } from "./base-queue.processor"

export function createQueueProcessor(
  queueDefinition: QueueDefinition,
): Type<BaseQueueProcessor> {
  @Injectable()
  @Processor(queueDefinition.name)
  class NamedQueueProcessor extends BaseQueueProcessor {
    protected readonly queueName = queueDefinition.name

    constructor(
      registry: JobRegistryService,
      @InjectQueue(queueDefinition.name) queue: Queue,
      @Optional()
      @Inject(QUEUE_MODULE_OPTIONS)
      options?: QueueModuleOptions,
    ) {
      super(registry, queue)

      const workerMetadata = buildWorkerMetadata(
        queueDefinition.concurrency,
        options?.telemetry,
      )
      if (workerMetadata) {
        SetMetadata(
          "bullmq:worker_metadata",
          workerMetadata,
        )(NamedQueueProcessor)
      }
    }
  }

  Object.defineProperty(NamedQueueProcessor, "name", {
    value: `QueueProcessor_${queueDefinition.name}`,
  })

  return NamedQueueProcessor
}
