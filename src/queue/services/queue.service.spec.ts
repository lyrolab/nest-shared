import { Job, Queue } from "bullmq"
import { JobRegistryService } from "./job-registry.service"
import { QueueService } from "./queue.service"

describe("QueueService", () => {
  const createQueue = () =>
    ({
      add: jest.fn().mockResolvedValue({} as Job),
      addBulk: jest
        .fn()
        .mockImplementation((jobs: unknown[]) =>
          Promise.resolve(jobs.map(() => ({}) as Job)),
        ),
    }) as unknown as Queue

  const createService = (queueByJobName: Record<string, string>) => {
    const registry = {
      resolveQueueName: jest.fn(
        (name: string) => queueByJobName[name] ?? "default",
      ),
    } as unknown as JobRegistryService

    const defaultQueue = createQueue()
    const notificationsQueue = createQueue()
    const queues = new Map<string, Queue>([
      ["default", defaultQueue],
      ["notifications", notificationsQueue],
    ])

    return {
      service: new QueueService(registry, queues),
      defaultQueue,
      notificationsQueue,
    }
  }

  it("adds a job to its declaring queue", async () => {
    const { service, notificationsQueue, defaultQueue } = createService({
      send_push: "notifications",
    })

    await service.add("send_push", { userId: 1 }, { attempts: 3 })

    expect(notificationsQueue.add).toHaveBeenCalledWith(
      "send_push",
      { userId: 1 },
      { attempts: 3 },
    )
    expect(defaultQueue.add).not.toHaveBeenCalled()
  })

  it("adds unregistered job names to the default queue", async () => {
    const { service, defaultQueue } = createService({})

    await service.add("ad-hoc-job", {})

    expect(defaultQueue.add).toHaveBeenCalledWith("ad-hoc-job", {}, undefined)
  })

  it("falls back to the default queue when the resolved queue is unknown", async () => {
    const { service, defaultQueue } = createService({ orphan: "removed-queue" })

    await service.add("orphan", {})

    expect(defaultQueue.add).toHaveBeenCalled()
  })

  it("groups bulk jobs into one addBulk call per queue", async () => {
    const { service, defaultQueue, notificationsQueue } = createService({
      send_push: "notifications",
    })

    const jobs = await service.addBulk([
      { name: "send_push", data: { id: 1 } },
      { name: "sync-job", data: { id: 2 } },
      { name: "send_push", data: { id: 3 }, opts: { delay: 100 } },
    ])

    expect(notificationsQueue.addBulk).toHaveBeenCalledTimes(1)
    expect(notificationsQueue.addBulk).toHaveBeenCalledWith([
      { name: "send_push", data: { id: 1 } },
      { name: "send_push", data: { id: 3 }, opts: { delay: 100 } },
    ])
    expect(defaultQueue.addBulk).toHaveBeenCalledTimes(1)
    expect(defaultQueue.addBulk).toHaveBeenCalledWith([
      { name: "sync-job", data: { id: 2 } },
    ])
    expect(jobs).toHaveLength(3)
  })
})
