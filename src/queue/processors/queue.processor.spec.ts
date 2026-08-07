import { DiscoveryService } from "@nestjs/core"
import { Job, Queue } from "bullmq"
import { JobProcessorMetadata } from "src/queue/decorators/queue.decorator"
import { QueueDefinition } from "src/queue/interfaces/queue-options.interface"
import { JobProcessorInterface } from "src/queue/models/job-processor-interface"
import { JobRegistryService } from "../services/job-registry.service"
import { QueueProcessor } from "./queue.processor"

describe("QueueProcessor", () => {
  const JOB_NAME = "my-job"

  const createRegistry = (
    jobProcessor: JobProcessorInterface | null,
    metadata: string | JobProcessorMetadata = JOB_NAME,
    queueDefinitions: QueueDefinition[] = [],
  ) => {
    const provider = { instance: jobProcessor }

    const discoveryService = {
      getProviders: jest.fn().mockReturnValue(jobProcessor ? [provider] : []),
      getMetadataByDecorator: jest.fn().mockReturnValue(metadata),
    } as unknown as DiscoveryService

    return new JobRegistryService(discoveryService, queueDefinitions)
  }

  const createQueue = (overrides: Partial<Queue> = {}) =>
    ({
      getActive: jest.fn().mockResolvedValue([]),
      getJobSchedulers: jest.fn().mockResolvedValue([]),
      removeJobScheduler: jest.fn().mockResolvedValue(undefined),
      upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    }) as unknown as Queue

  const createProcessor = (
    jobProcessor: JobProcessorInterface | null,
    queueOverrides: Partial<Queue> = {},
    metadata: string | JobProcessorMetadata = JOB_NAME,
    queueDefinitions: QueueDefinition[] = [],
  ) => {
    const queue = createQueue(queueOverrides)
    const registry = createRegistry(jobProcessor, metadata, queueDefinitions)
    return { processor: new QueueProcessor(registry, queue), queue }
  }

  const makeJob = (overrides: Partial<Job> = {}): Job =>
    ({ name: JOB_NAME, repeatJobKey: undefined, ...overrides }) as Job

  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(console, "error").mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    Reflect.deleteMetadata("bullmq:worker_metadata", QueueProcessor)
  })

  it("rethrows handler errors so BullMQ can mark the job failed and retry", async () => {
    const error = new Error("handler blew up")
    const jobProcessor: JobProcessorInterface = {
      process: jest.fn().mockRejectedValue(error),
    }

    const { processor } = createProcessor(jobProcessor)

    await expect(processor.process(makeJob())).rejects.toBe(error)
    expect(console.error).toHaveBeenCalledWith(error)
  })

  it("resolves without throwing when the handler succeeds", async () => {
    const jobProcessor: JobProcessorInterface = {
      process: jest.fn().mockResolvedValue(undefined),
    }

    const { processor } = createProcessor(jobProcessor)

    await expect(processor.process(makeJob())).resolves.toBeUndefined()
    expect(jobProcessor.process).toHaveBeenCalledTimes(1)
  })

  it("does nothing when no processor is registered for the job", async () => {
    const { processor } = createProcessor(null)

    await expect(processor.process(makeJob())).resolves.toBeUndefined()
  })

  it("does not process jobs registered on another queue", async () => {
    const jobProcessor: JobProcessorInterface = {
      process: jest.fn().mockResolvedValue(undefined),
    }

    const { processor } = createProcessor(
      jobProcessor,
      {},
      { name: JOB_NAME, queue: "notifications" },
      [{ name: "notifications" }],
    )

    await expect(processor.process(makeJob())).resolves.toBeUndefined()
    expect(jobProcessor.process).not.toHaveBeenCalled()
  })

  it("sets worker metadata when concurrency is configured", () => {
    const registry = createRegistry(null)
    new QueueProcessor(registry, createQueue(), { concurrency: 5 })

    expect(
      Reflect.getMetadata("bullmq:worker_metadata", QueueProcessor),
    ).toEqual({ concurrency: 5 })
  })

  it("sets no worker metadata without options", () => {
    const registry = createRegistry(null)
    new QueueProcessor(registry, createQueue())

    expect(
      Reflect.getMetadata("bullmq:worker_metadata", QueueProcessor),
    ).toBeUndefined()
  })

  describe("cron scheduling", () => {
    it("upserts a scheduler for its own cron jobs", async () => {
      const jobProcessor: JobProcessorInterface = {
        process: jest.fn(),
      }
      const { processor, queue } = createProcessor(
        jobProcessor,
        {},
        {
          name: JOB_NAME,
          cron: "*/5 * * * *",
        },
      )

      await processor.onModuleInit()

      expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
        JOB_NAME,
        { pattern: "*/5 * * * *" },
        { name: JOB_NAME },
      )
    })

    it("does not schedule cron jobs registered on another queue", async () => {
      const jobProcessor: JobProcessorInterface = {
        process: jest.fn(),
      }
      const { processor, queue } = createProcessor(
        jobProcessor,
        {},
        { name: JOB_NAME, cron: "*/5 * * * *", queue: "notifications" },
        [{ name: "notifications" }],
      )

      await processor.onModuleInit()

      expect(queue.upsertJobScheduler).not.toHaveBeenCalled()
    })

    it("removes a scheduler whose cron pattern changed before upserting", async () => {
      const jobProcessor: JobProcessorInterface = {
        process: jest.fn(),
      }
      const { processor, queue } = createProcessor(
        jobProcessor,
        {
          getJobSchedulers: jest
            .fn()
            .mockResolvedValue([
              { key: "stale-key", name: JOB_NAME, pattern: "0 0 * * *" },
            ]),
        },
        { name: JOB_NAME, cron: "*/5 * * * *" },
      )

      await processor.onModuleInit()

      expect(queue.removeJobScheduler).toHaveBeenCalledWith("stale-key")
      expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
        JOB_NAME,
        { pattern: "*/5 * * * *" },
        { name: JOB_NAME },
      )
    })

    it("removes a scheduler for a job that moved to another queue", async () => {
      const jobProcessor: JobProcessorInterface = {
        process: jest.fn(),
      }
      const { processor, queue } = createProcessor(
        jobProcessor,
        {
          getJobSchedulers: jest
            .fn()
            .mockResolvedValue([
              { key: "moved-key", name: JOB_NAME, pattern: "*/5 * * * *" },
            ]),
        },
        { name: JOB_NAME, cron: "*/5 * * * *", queue: "notifications" },
        [{ name: "notifications" }],
      )

      await processor.onModuleInit()

      expect(queue.removeJobScheduler).toHaveBeenCalledWith("moved-key")
      expect(queue.upsertJobScheduler).not.toHaveBeenCalled()
    })

    it("leaves schedulers unknown to the module untouched", async () => {
      const { processor, queue } = createProcessor(null, {
        getJobSchedulers: jest
          .fn()
          .mockResolvedValue([
            { key: "foreign-key", name: "foreign-job", pattern: "0 0 * * *" },
          ]),
      })

      await processor.onModuleInit()

      expect(queue.removeJobScheduler).not.toHaveBeenCalled()
    })
  })
})
