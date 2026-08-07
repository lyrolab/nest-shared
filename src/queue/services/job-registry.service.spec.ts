import { DiscoveryService } from "@nestjs/core"
import { JobProcessorMetadata } from "../decorators/queue.decorator"
import { JobProcessorInterface } from "../models/job-processor-interface"
import { QueueDefinition } from "../interfaces/queue-options.interface"
import { JobRegistryService } from "./job-registry.service"

describe("JobRegistryService", () => {
  const processor: JobProcessorInterface = { process: jest.fn() }

  const createRegistry = (
    metadataList: Array<string | JobProcessorMetadata>,
    queueDefinitions: QueueDefinition[] = [],
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

    return new JobRegistryService(discoveryService, queueDefinitions)
  }

  it("normalizes string metadata to the default queue", () => {
    const registry = createRegistry(["my-job"])

    expect(registry.getJob("my-job")).toEqual({
      name: "my-job",
      cron: undefined,
      queue: "default",
      instance: processor,
    })
  })

  it("resolves a job to its declared queue", () => {
    const registry = createRegistry(
      [{ name: "send_push", queue: "notifications" }],
      [{ name: "notifications" }],
    )

    expect(registry.resolveQueueName("send_push")).toBe("notifications")
  })

  it("resolves unregistered job names to the default queue", () => {
    const registry = createRegistry([])

    expect(registry.resolveQueueName("ad-hoc-job")).toBe("default")
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
      [{ name: "sync" }, { name: "notifications" }],
    )

    expect(() => registry.validate()).toThrow(/refresh/)
  })

  it("keeps first-wins behavior for same-queue duplicates", () => {
    const registry = createRegistry(["my-job", "my-job"])

    expect(() => registry.validate()).not.toThrow()
    expect(registry.getJobs()).toHaveLength(1)
  })

  it("throws when a job references an unregistered queue", () => {
    const registry = createRegistry([{ name: "send_push", queue: "typo" }])

    expect(() => registry.validate()).toThrow(/send_push.*typo/)
  })
})
