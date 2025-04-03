import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq"
import { DiscoveryService } from "@nestjs/core"
import { Job, Queue } from "bullmq"
import { JobProcessor } from "../decorators/queue.decorator"
import { JobProcessorInterface } from "../models/job-processor-interface"
import { DEFAULT_QUEUE } from "../queue.constants"

@Processor(DEFAULT_QUEUE, { concurrency: 100 })
export class QueueProcessor extends WorkerHost {
  constructor(
    private readonly discoveryService: DiscoveryService,
    @InjectQueue(DEFAULT_QUEUE) private readonly queue: Queue,
  ) {
    super()
  }

  async process(job: Job) {
    const jobProcessor = this.jobProcessorFor(job.name)
    if (!jobProcessor) return

    const shouldProcess = await this.shouldProcessJob(job)
    if (!shouldProcess) return

    try {
      await jobProcessor.process(job)
    } catch (error) {
      console.error(error)
    }
  }

  private jobProcessorFor(jobName: string) {
    return this.discoveryService
      .getProviders({ metadataKey: JobProcessor.KEY })
      .find(
        (provider) =>
          this.discoveryService.getMetadataByDecorator(
            JobProcessor,
            provider,
          ) === jobName,
      )?.instance as JobProcessorInterface
  }

  private async shouldProcessJob(job: Job) {
    if (!job.repeatJobKey) return true

    const activeJobs = await this.queue.getActive()
    const activeJobsOfSameCronjob = activeJobs.filter(
      ({ name, id }) => name === job.name && id !== job.id,
    )

    return activeJobsOfSameCronjob.length === 0
  }
}
