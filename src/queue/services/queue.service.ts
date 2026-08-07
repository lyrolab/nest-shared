import { Inject, Injectable } from "@nestjs/common"
import { Job, JobsOptions, Queue } from "bullmq"
import { DEFAULT_QUEUE, QUEUE_MAP } from "../queue.constants"
import { JobRegistryService } from "./job-registry.service"

export type QueueBulkJob = {
  name: string
  data: any
  opts?: JobsOptions
}

@Injectable()
export class QueueService {
  constructor(
    private readonly registry: JobRegistryService,
    @Inject(QUEUE_MAP) private readonly queues: Map<string, Queue>,
  ) {}

  add(
    name: string,
    data: any,
    opts?: JobsOptions,
  ): Promise<Job<any, any, string>> {
    return this.queueFor(name).add(name, data, opts)
  }

  async addBulk(jobs: QueueBulkJob[]): Promise<Job<any, any, string>[]> {
    const jobsByQueue = new Map<string, QueueBulkJob[]>()
    for (const job of jobs) {
      const queueName = this.registry.resolveQueueName(job.name)
      const group = jobsByQueue.get(queueName) ?? []
      group.push(job)
      jobsByQueue.set(queueName, group)
    }

    const results = await Promise.all(
      [...jobsByQueue.entries()].map(([queueName, group]) =>
        this.queueOrDefault(queueName).addBulk(group),
      ),
    )

    return results.flat()
  }

  private queueFor(name: string): Queue {
    return this.queueOrDefault(this.registry.resolveQueueName(name))
  }

  private queueOrDefault(queueName: string): Queue {
    return this.queues.get(queueName) ?? this.queues.get(DEFAULT_QUEUE)!
  }
}
