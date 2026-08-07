import { InjectQueue, Processor } from "@nestjs/bullmq"
import { Inject, Injectable, Optional, SetMetadata, Type } from "@nestjs/common"
import { Queue } from "bullmq"
import {
  QueueDefinition,
  QueueModuleOptions,
} from "../interfaces/queue-options.interface"
import {
  DEFAULT_QUEUE,
  QUEUE_MODULE_OPTIONS,
  WORKER_METADATA_KEY,
} from "../queue.constants"
import { JobRegistryService } from "../services/job-registry.service"
import { BaseQueueProcessor } from "./base-queue.processor"

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

      // The default queue's concurrency comes from the module-level option;
      // telemetry may only be known at DI time (forRootAsync), hence
      // constructor-time metadata instead of decorator worker options.
      const concurrency =
        queueDefinition.concurrency ??
        (queueDefinition.name === DEFAULT_QUEUE
          ? options?.concurrency
          : undefined)
      const telemetry = options?.telemetry

      if (concurrency || telemetry) {
        SetMetadata(WORKER_METADATA_KEY, {
          ...(concurrency && { concurrency }),
          ...(telemetry && { telemetry }),
        })(NamedQueueProcessor)
      }
    }
  }

  Object.defineProperty(NamedQueueProcessor, "name", {
    value: `QueueProcessor_${queueDefinition.name}`,
  })

  return NamedQueueProcessor
}
