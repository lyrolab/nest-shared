import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq"
import { DiscoveryService } from "@nestjs/core"
import { Job, Queue } from "bullmq"
import { JobProcessorInterface } from "src/queue/models/job-processor-interface"
import { JobProcessor } from "../decorators/queue.decorator"
import { DEFAULT_QUEUE, QUEUE_MODULE_OPTIONS } from "../queue.constants"
import {
  OnModuleInit,
  Injectable,
  Inject,
  Optional,
  SetMetadata,
} from "@nestjs/common"
import { QueueModuleOptions } from "../interfaces/queue-options.interface"

@Injectable()
@Processor(DEFAULT_QUEUE)
export class QueueProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    private readonly discoveryService: DiscoveryService,
    @InjectQueue(DEFAULT_QUEUE) private readonly queue: Queue,
    @Optional()
    @Inject(QUEUE_MODULE_OPTIONS)
    private readonly options?: QueueModuleOptions,
  ) {
    super()

    if (this.options?.concurrency) {
      SetMetadata("bullmq:worker_metadata", this.options)(QueueProcessor)
    }
  }

  async onModuleInit() {
    const jobConfigs = this.getJobConfigurations()
    await this.scheduleJobs(jobConfigs)
  }

  async process(job: Job) {
    const jobProcessor = this.getJobProcessorByName(job.name)
    if (!jobProcessor) return

    const shouldProcess = await this.shouldProcessJob(job)
    if (!shouldProcess) return

    try {
      await jobProcessor.process(job)
    } catch (error) {
      console.error(error)
    }
  }

  private getJobConfigurations(): Array<{ name: string; cron?: string }> {
    return this.discoveryService
      .getProviders({ metadataKey: JobProcessor.KEY })
      .map((provider) => {
        const metadata = this.discoveryService.getMetadataByDecorator(
          JobProcessor,
          provider,
        )

        if (!metadata) return null

        if (typeof metadata === "string") {
          return { name: metadata }
        }

        return { name: metadata.name, cron: metadata.cron }
      })
      .filter((job): job is { name: string; cron?: string } => job !== null)
  }

  private async scheduleJobs(
    jobConfigs: Array<{ name: string; cron?: string }>,
  ) {
    const schedulingPromises = jobConfigs
      .filter((job) => job.cron)
      .map(async ({ name, cron }) => {
        const existingSchedulers = await this.queue.getJobSchedulers()

        const outdatedSchedulers = existingSchedulers.filter(
          (scheduler) => scheduler.name === name && scheduler.pattern !== cron,
        )

        await Promise.allSettled(
          outdatedSchedulers.map((scheduler) =>
            this.queue.removeJobScheduler(scheduler.key),
          ),
        )
        await this.queue.upsertJobScheduler(name, { pattern: cron }, { name })
      })

    await Promise.all(schedulingPromises)
  }

  private async shouldProcessJob(job: Job) {
    if (!job.repeatJobKey) return true

    const activeJobs = await this.queue.getActive()
    const activeJobsOfSameType = activeJobs.filter(
      (activeJob: Job) =>
        activeJob.name === job.name && activeJob.id !== job.id,
    )

    return activeJobsOfSameType.length === 0
  }

  private getJobProcessorByName(jobName: string): JobProcessorInterface | null {
    const providerWithProcessor = this.discoveryService
      .getProviders({ metadataKey: JobProcessor.KEY })
      .find((provider) => {
        const metadata = this.discoveryService.getMetadataByDecorator(
          JobProcessor,
          provider,
        )

        if (!metadata) return false

        const name = typeof metadata === "string" ? metadata : metadata.name

        return name === jobName
      })

    return (providerWithProcessor?.instance as JobProcessorInterface) ?? null
  }
}
