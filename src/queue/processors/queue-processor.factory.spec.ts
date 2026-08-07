import { DiscoveryService } from "@nestjs/core"
import { Job, Queue, Telemetry } from "bullmq"
import { JobProcessorMetadata } from "src/queue/decorators/queue.decorator"
import { JobProcessorInterface } from "src/queue/models/job-processor-interface"
import { JobRegistryService } from "../services/job-registry.service"
import { createQueueProcessor } from "./queue-processor.factory"

describe("createQueueProcessor", () => {
  const createRegistry = (
    jobProcessor: JobProcessorInterface | null,
    metadata: string | JobProcessorMetadata,
  ) => {
    const provider = { instance: jobProcessor }

    const discoveryService = {
      getProviders: jest.fn().mockReturnValue(jobProcessor ? [provider] : []),
      getMetadataByDecorator: jest.fn().mockReturnValue(metadata),
    } as unknown as DiscoveryService

    return new JobRegistryService(discoveryService, [{ name: "notifications" }])
  }

  const createQueue = () =>
    ({
      getActive: jest.fn().mockResolvedValue([]),
      getJobSchedulers: jest.fn().mockResolvedValue([]),
      removeJobScheduler: jest.fn().mockResolvedValue(undefined),
      upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    }) as unknown as Queue

  it("binds the generated class to its queue", () => {
    const processorClass = createQueueProcessor({ name: "notifications" })

    expect(
      Reflect.getMetadata("bullmq:processor_metadata", processorClass),
    ).toEqual({ name: "notifications" })
    expect(processorClass.name).toBe("QueueProcessor_notifications")
  })

  it("generates distinct classes per queue", () => {
    const first = createQueueProcessor({ name: "sync" })
    const second = createQueueProcessor({ name: "notifications" })

    expect(first).not.toBe(second)
    expect(Reflect.getMetadata("bullmq:processor_metadata", second)).toEqual({
      name: "notifications",
    })
  })

  it("sets worker metadata from the queue definition and telemetry option", () => {
    const telemetry = { tracer: {} } as unknown as Telemetry
    const processorClass = createQueueProcessor({
      name: "notifications",
      concurrency: 7,
    })

    new processorClass(createRegistry(null, "unused"), createQueue(), {
      telemetry,
    })

    expect(
      Reflect.getMetadata("bullmq:worker_metadata", processorClass),
    ).toEqual({ concurrency: 7, telemetry })
  })

  it("sets no worker metadata without concurrency or telemetry", () => {
    const processorClass = createQueueProcessor({ name: "notifications" })

    new processorClass(createRegistry(null, "unused"), createQueue())

    expect(
      Reflect.getMetadata("bullmq:worker_metadata", processorClass),
    ).toBeUndefined()
  })

  it("processes jobs registered on its own queue", async () => {
    const jobProcessor: JobProcessorInterface = {
      process: jest.fn().mockResolvedValue(undefined),
    }
    const processorClass = createQueueProcessor({ name: "notifications" })
    const processor = new processorClass(
      createRegistry(jobProcessor, {
        name: "send_push",
        queue: "notifications",
      }),
      createQueue(),
    )

    await processor.process({ name: "send_push" } as Job)

    expect(jobProcessor.process).toHaveBeenCalledTimes(1)
  })

  it("ignores jobs registered on the default queue", async () => {
    const jobProcessor: JobProcessorInterface = {
      process: jest.fn().mockResolvedValue(undefined),
    }
    const processorClass = createQueueProcessor({ name: "notifications" })
    const processor = new processorClass(
      createRegistry(jobProcessor, "default-job"),
      createQueue(),
    )

    await processor.process({ name: "default-job" } as Job)

    expect(jobProcessor.process).not.toHaveBeenCalled()
  })
})
