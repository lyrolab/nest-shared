import { Inject, Injectable, Optional } from "@nestjs/common"
import { DiscoveryService } from "@nestjs/core"
import {
  JobProcessor,
  JobProcessorMetadata,
} from "../decorators/queue.decorator"
import { QueueDefinition } from "../interfaces/queue-options.interface"
import { JobProcessorInterface } from "../models/job-processor-interface"
import { DEFAULT_QUEUE, QUEUE_DEFINITIONS } from "../queue.constants"

export type JobRegistration = {
  name: string
  cron?: string
  queue: string
  instance: JobProcessorInterface | null
}

@Injectable()
export class JobRegistryService {
  private registrations?: Map<string, JobRegistration>

  constructor(
    private readonly discoveryService: DiscoveryService,
    @Optional()
    @Inject(QUEUE_DEFINITIONS)
    private readonly queueDefinitions: QueueDefinition[] = [],
  ) {}

  getJobs(): JobRegistration[] {
    return [...this.load().values()]
  }

  getJob(name: string): JobRegistration | undefined {
    return this.load().get(name)
  }

  resolveQueueName(name: string): string {
    return this.load().get(name)?.queue ?? DEFAULT_QUEUE
  }

  validate(): void {
    this.load()
  }

  private load(): Map<string, JobRegistration> {
    if (this.registrations) return this.registrations

    const knownQueues = new Set([
      DEFAULT_QUEUE,
      ...this.queueDefinitions.map((queue) => queue.name),
    ])
    const registrations = new Map<string, JobRegistration>()

    for (const provider of this.discoveryService.getProviders({
      metadataKey: JobProcessor.KEY,
    })) {
      const metadata = this.discoveryService.getMetadataByDecorator(
        JobProcessor,
        provider,
      )
      if (!metadata) continue

      const normalized: JobProcessorMetadata =
        typeof metadata === "string" ? { name: metadata } : metadata
      const { name, cron, queue = DEFAULT_QUEUE } = normalized

      if (!knownQueues.has(queue)) {
        throw new Error(
          `Job "${name}" is registered on unknown queue "${queue}". Declare it in the module's "queues" option.`,
        )
      }

      const existing = registrations.get(name)
      if (existing) {
        if (existing.queue !== queue) {
          throw new Error(
            `Job name "${name}" is registered on multiple queues ("${existing.queue}", "${queue}"). Job names must be globally unique.`,
          )
        }
        continue
      }

      registrations.set(name, {
        name,
        cron,
        queue,
        instance: (provider.instance as JobProcessorInterface) ?? null,
      })
    }

    this.registrations = registrations
    return registrations
  }
}
