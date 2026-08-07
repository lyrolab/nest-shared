import { DiscoveryService } from "@nestjs/core"
import { Queue } from "bullmq"
import { JobProcessorMetadata } from "../decorators/queue.decorator"
import { JobProcessorInterface } from "../models/job-processor-interface"
import { DEFAULT_QUEUE } from "../queue.constants"
import { JobRegistryService } from "./job-registry.service"

describe("JobRegistryService", () => {
  const processor: JobProcessorInterface = { process: jest.fn() }

  const createRegistry = (
    metadataList: Array<string | JobProcessorMetadata>,
    queueNames: string[] = [DEFAULT_QUEUE],
  ) => {
    const providers = metadataList.map((metadata) => ({
      instance: processor,
      metadata,
    }))

    const discoveryService = {
      getProviders: jest.fn().mockReturnValue(providers),
      getMetadataByDecorator: jest.fn(
        (_decorator: unknown, provider: { metadata: unknown }) =>
          provider.metadata,
      ),
    } as unknown as DiscoveryService

    const queues = new Map<string, Queue>(
      queueNames.map((name) => [name, {} as Queue]),
    )

    return new JobRegistryService(discoveryService, queues)
  }

  it("normalizes string metadata to the default queue", () => {
    const registry = createRegistry(["my-job"])

    expect(registry.getJob("my-job")).toEqual({
      name: "my-job",
      cron: undefined,
      queue: DEFAULT_QUEUE,
      instance: processor,
    })
  })

  it("resolves a job to its declared queue", () => {
    const registry = createRegistry(
      [{ name: "send_push", queue: "notifications" }],
      [DEFAULT_QUEUE, "notifications"],
    )

    expect(registry.resolveQueueName("send_push")).toBe("notifications")
  })

  it("resolves unregistered job names to the default queue", () => {
    const registry = createRegistry([])

    expect(registry.resolveQueueName("ad-hoc-job")).toBe(DEFAULT_QUEUE)
  })

  it("carries the cron expression", () => {
    const registry = createRegistry([{ name: "nightly", cron: "0 0 * * *" }])

    expect(registry.getJob("nightly")?.cron).toBe("0 0 * * *")
  })

  it("throws when the same job name is registered on two queues", () => {
    const registry = createRegistry(
      [
        { name: "refresh", queue: "sync" },
        { name: "refresh", queue: "notifications" },
      ],
      [DEFAULT_QUEUE, "sync", "notifications"],
    )

    expect(() => registry.getJobs()).toThrow(/refresh/)
  })

  it("keeps first-wins behavior for same-queue duplicates", () => {
    const registry = createRegistry(["my-job", "my-job"])

    expect(registry.getJobs()).toHaveLength(1)
  })

  it("throws when a job references an unregistered queue", () => {
    const registry = createRegistry([{ name: "send_push", queue: "typo" }])

    expect(() => registry.getJobs()).toThrow(/send_push.*typo/)
  })
})
