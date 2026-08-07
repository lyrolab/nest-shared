import { DiscoveryService } from "@nestjs/core"
import { Job, Queue, Telemetry } from "bullmq"
import { JobProcessorMetadata } from "../decorators/queue.decorator"
import { QueueModuleOptions } from "../interfaces/queue-options.interface"
import { JobProcessorInterface } from "../models/job-processor-interface"
import {
  DEFAULT_QUEUE,
  PROCESSOR_METADATA_KEY,
  WORKER_METADATA_KEY,
} from "../queue.constants"
import { JobRegistryService } from "../services/job-registry.service"
import { createQueueProcessor } from "./queue-processor.factory"

describe("createQueueProcessor", () => {
  const JOB_NAME = "my-job"

  const createRegistry = (
    jobProcessor: JobProcessorInterface | null,
    metadata: string | JobProcessorMetadata = JOB_NAME,
    queueNames: string[] = [DEFAULT_QUEUE, "notifications"],
  ) => {
    const provider = { instance: jobProcessor }

    const discoveryService = {
      getProviders: jest.fn().mockReturnValue(jobProcessor ? [provider] : []),
      getMetadataByDecorator: jest.fn().mockReturnValue(metadata),
    } as unknown as DiscoveryService

    const queues = new Map<string, Queue>(
      queueNames.map((name) => [name, {} as Queue]),
    )

    return new JobRegistryService(discoveryService, queues)
  }

  const createQueue = (overrides: Partial<Queue> = {}) =>
    ({
      getActive: jest.fn().mockResolvedValue([]),
      getJobSchedulers: jest.fn().mockResolvedValue([]),
      removeJobScheduler: jest.fn().mockResolvedValue(undefined),
      upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    }) as unknown as Queue

  const createProcessor = ({
    jobProcessor = null,
    metadata = JOB_NAME,
    queueName = DEFAULT_QUEUE,
    concurrency,
    queueOverrides = {},
    options,
  }: {
    jobProcessor?: JobProcessorInterface | null
    metadata?: string | JobProcessorMetadata
    queueName?: string
    concurrency?: number
    queueOverrides?: Partial<Queue>
    options?: QueueModuleOptions
  } = {}) => {
    const processorClass = createQueueProcessor({
      name: queueName,
      concurrency,
    })
    const queue = createQueue(queueOverrides)
    const registry = createRegistry(jobProcessor, metadata)
    const processor = new processorClass(registry, queue, options)
    return { processor, processorClass, queue }
  }

  const makeJob = (overrides: Partial<Job> = {}): Job =>
    ({ name: JOB_NAME, repeatJobKey: undefined, ...overrides }) as Job

  beforeEach(() => {
    jest.spyOn(console, "error").mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe("class generation", () => {
    it("binds the generated class to its queue", () => {
      const processorClass = createQueueProcessor({ name: "notifications" })

      expect(
        Reflect.getMetadata(PROCESSOR_METADATA_KEY, processorClass),
      ).toEqual({ name: "notifications" })
      expect(processorClass.name).toBe("QueueProcessor_notifications")
    })

    it("generates distinct classes per queue", () => {
      const first = createQueueProcessor({ name: "sync" })
      const second = createQueueProcessor({ name: "notifications" })

      expect(first).not.toBe(second)
      expect(Reflect.getMetadata(PROCESSOR_METADATA_KEY, second)).toEqual({
        name: "notifications",
      })
    })
  })

  describe("worker metadata", () => {
    it("combines the definition's concurrency with the telemetry option", () => {
      const telemetry = { tracer: {} } as unknown as Telemetry
      const { processorClass } = createProcessor({
        queueName: "notifications",
        concurrency: 7,
        options: { telemetry },
      })

      expect(Reflect.getMetadata(WORKER_METADATA_KEY, processorClass)).toEqual({
        concurrency: 7,
        telemetry,
      })
    })

    it("falls back to the module-level concurrency for the default queue", () => {
      const { processorClass } = createProcessor({
        queueName: DEFAULT_QUEUE,
        options: { concurrency: 5 },
      })

      expect(Reflect.getMetadata(WORKER_METADATA_KEY, processorClass)).toEqual({
        concurrency: 5,
      })
    })

    it("does not apply the module-level concurrency to named queues", () => {
      const { processorClass } = createProcessor({
        queueName: "notifications",
        options: { concurrency: 5 },
      })

      expect(
        Reflect.getMetadata(WORKER_METADATA_KEY, processorClass),
      ).toBeUndefined()
    })

    it("sets no worker metadata without concurrency or telemetry", () => {
      const { processorClass } = createProcessor({
        queueName: "notifications",
      })

      expect(
        Reflect.getMetadata(WORKER_METADATA_KEY, processorClass),
      ).toBeUndefined()
    })
  })

  describe("process", () => {
    it("rethrows handler errors so BullMQ can mark the job failed and retry", async () => {
      const error = new Error("handler blew up")
      const { processor } = createProcessor({
        jobProcessor: { process: jest.fn().mockRejectedValue(error) },
      })

      await expect(processor.process(makeJob())).rejects.toBe(error)
      expect(console.error).toHaveBeenCalledWith(error)
    })

    it("resolves without throwing when the handler succeeds", async () => {
      const jobProcessor: JobProcessorInterface = {
        process: jest.fn().mockResolvedValue(undefined),
      }
      const { processor } = createProcessor({ jobProcessor })

      await expect(processor.process(makeJob())).resolves.toBeUndefined()
      expect(jobProcessor.process).toHaveBeenCalledTimes(1)
    })

    it("does nothing when no processor is registered for the job", async () => {
      const { processor } = createProcessor()

      await expect(processor.process(makeJob())).resolves.toBeUndefined()
    })

    it("does not process jobs registered on another queue", async () => {
      const jobProcessor: JobProcessorInterface = {
        process: jest.fn().mockResolvedValue(undefined),
      }
      const { processor } = createProcessor({
        jobProcessor,
        metadata: { name: JOB_NAME, queue: "notifications" },
      })

      await expect(processor.process(makeJob())).resolves.toBeUndefined()
      expect(jobProcessor.process).not.toHaveBeenCalled()
    })

    it("processes jobs registered on its own named queue", async () => {
      const jobProcessor: JobProcessorInterface = {
        process: jest.fn().mockResolvedValue(undefined),
      }
      const { processor } = createProcessor({
        jobProcessor,
        queueName: "notifications",
        metadata: { name: JOB_NAME, queue: "notifications" },
      })

      await processor.process(makeJob())

      expect(jobProcessor.process).toHaveBeenCalledTimes(1)
    })
  })

  describe("cron scheduling", () => {
    const jobProcessor: JobProcessorInterface = { process: jest.fn() }

    it("upserts a scheduler for its own cron jobs", async () => {
      const { processor, queue } = createProcessor({
        jobProcessor,
        metadata: { name: JOB_NAME, cron: "*/5 * * * *" },
      })

      await processor.onModuleInit()

      expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
        JOB_NAME,
        { pattern: "*/5 * * * *" },
        { name: JOB_NAME },
      )
    })

    it("does not schedule cron jobs registered on another queue", async () => {
      const { processor, queue } = createProcessor({
        jobProcessor,
        metadata: {
          name: JOB_NAME,
          cron: "*/5 * * * *",
          queue: "notifications",
        },
      })

      await processor.onModuleInit()

      expect(queue.upsertJobScheduler).not.toHaveBeenCalled()
    })

    it("removes a scheduler whose cron pattern changed before upserting", async () => {
      const { processor, queue } = createProcessor({
        jobProcessor,
        metadata: { name: JOB_NAME, cron: "*/5 * * * *" },
        queueOverrides: {
          getJobSchedulers: jest
            .fn()
            .mockResolvedValue([
              { key: "stale-key", name: JOB_NAME, pattern: "0 0 * * *" },
            ]),
        },
      })

      await processor.onModuleInit()

      expect(queue.removeJobScheduler).toHaveBeenCalledWith("stale-key")
      expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
        JOB_NAME,
        { pattern: "*/5 * * * *" },
        { name: JOB_NAME },
      )
    })

    it("removes a scheduler for a job that moved to another queue", async () => {
      const { processor, queue } = createProcessor({
        jobProcessor,
        metadata: {
          name: JOB_NAME,
          cron: "*/5 * * * *",
          queue: "notifications",
        },
        queueOverrides: {
          getJobSchedulers: jest
            .fn()
            .mockResolvedValue([
              { key: "moved-key", name: JOB_NAME, pattern: "*/5 * * * *" },
            ]),
        },
      })

      await processor.onModuleInit()

      expect(queue.removeJobScheduler).toHaveBeenCalledWith("moved-key")
      expect(queue.upsertJobScheduler).not.toHaveBeenCalled()
    })

    it("leaves schedulers unknown to the module untouched", async () => {
      const { processor, queue } = createProcessor({
        queueOverrides: {
          getJobSchedulers: jest
            .fn()
            .mockResolvedValue([
              { key: "foreign-key", name: "foreign-job", pattern: "0 0 * * *" },
            ]),
        },
      })

      await processor.onModuleInit()

      expect(queue.removeJobScheduler).not.toHaveBeenCalled()
    })
  })
})
