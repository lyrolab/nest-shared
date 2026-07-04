import { DiscoveryService } from "@nestjs/core"
import { Job, Queue } from "bullmq"
import { JobProcessorInterface } from "src/queue/models/job-processor-interface"
import { QueueProcessor } from "./queue.processor"

describe("QueueProcessor", () => {
  const JOB_NAME = "my-job"

  const createProcessor = (
    jobProcessor: JobProcessorInterface | null,
    queueOverrides: Partial<Queue> = {},
  ) => {
    const provider = { instance: jobProcessor }

    const discoveryService = {
      getProviders: jest.fn().mockReturnValue(jobProcessor ? [provider] : []),
      getMetadataByDecorator: jest.fn().mockReturnValue(JOB_NAME),
    } as unknown as DiscoveryService

    const queue = {
      getActive: jest.fn().mockResolvedValue([]),
      ...queueOverrides,
    } as unknown as Queue

    return new QueueProcessor(discoveryService, queue)
  }

  const makeJob = (overrides: Partial<Job> = {}): Job =>
    ({ name: JOB_NAME, repeatJobKey: undefined, ...overrides }) as Job

  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(console, "error").mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("rethrows handler errors so BullMQ can mark the job failed and retry", async () => {
    const error = new Error("handler blew up")
    const jobProcessor: JobProcessorInterface = {
      process: jest.fn().mockRejectedValue(error),
    }

    const processor = createProcessor(jobProcessor)

    await expect(processor.process(makeJob())).rejects.toBe(error)
    expect(console.error).toHaveBeenCalledWith(error)
  })

  it("resolves without throwing when the handler succeeds", async () => {
    const jobProcessor: JobProcessorInterface = {
      process: jest.fn().mockResolvedValue(undefined),
    }

    const processor = createProcessor(jobProcessor)

    await expect(processor.process(makeJob())).resolves.toBeUndefined()
    expect(jobProcessor.process).toHaveBeenCalledTimes(1)
  })

  it("does nothing when no processor is registered for the job", async () => {
    const processor = createProcessor(null)

    await expect(processor.process(makeJob())).resolves.toBeUndefined()
  })
})
