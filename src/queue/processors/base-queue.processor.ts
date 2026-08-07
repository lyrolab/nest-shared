import { WorkerHost } from "@nestjs/bullmq"
import { OnModuleInit } from "@nestjs/common"
import { Job, Queue, Telemetry } from "bullmq"
import { JobRegistryService } from "../services/job-registry.service"

export type WorkerMetadata = {
  concurrency?: number
  telemetry?: Telemetry
}

export const buildWorkerMetadata = (
  concurrency?: number,
  telemetry?: Telemetry,
): WorkerMetadata | null => {
  if (!concurrency && !telemetry) return null
  return {
    ...(concurrency && { concurrency }),
    ...(telemetry && { telemetry }),
  }
}

export abstract class BaseQueueProcessor
  extends WorkerHost
  implements OnModuleInit
{
  protected abstract readonly queueName: string

  constructor(
    protected readonly registry: JobRegistryService,
    protected readonly queue: Queue,
  ) {
    super()
  }

  async onModuleInit() {
    this.registry.validate()
    await this.syncSchedulers()
  }

  async process(job: Job) {
    const registration = this.registry.getJob(job.name)
    if (!registration?.instance || registration.queue !== this.queueName) return

    const shouldProcess = await this.shouldProcessJob(job)
    if (!shouldProcess) return

    try {
      await registration.instance.process(job)
    } catch (error) {
      console.error(error)
      // Rethrow so BullMQ marks the job failed and honors attempts/backoff.
      throw error
    }
  }

  private async syncSchedulers() {
    const schedulers = await this.queue.getJobSchedulers()

    const staleSchedulers = schedulers.filter((scheduler) => {
      if (!scheduler.name) return false
      const registration = this.registry.getJob(scheduler.name)
      if (!registration) return false
      if (registration.queue !== this.queueName) return true
      return !!registration.cron && scheduler.pattern !== registration.cron
    })

    await Promise.allSettled(
      staleSchedulers.map((scheduler) =>
        this.queue.removeJobScheduler(scheduler.key),
      ),
    )

    const ownCronJobs = this.registry
      .getJobs()
      .filter((job) => job.queue === this.queueName && job.cron)

    await Promise.all(
      ownCronJobs.map(({ name, cron }) =>
        this.queue.upsertJobScheduler(name, { pattern: cron }, { name }),
      ),
    )
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
}
