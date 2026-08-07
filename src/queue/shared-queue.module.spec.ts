import { BullModule, getQueueToken } from "@nestjs/bullmq"
import { Test } from "@nestjs/testing"
import { Queue, Telemetry } from "bullmq"
import { QueueProcessor } from "./processors/queue.processor"
import { DEFAULT_QUEUE } from "./queue.constants"
import { QueueService } from "./services/queue.service"
import { SharedQueueModule } from "./shared-queue.module"

describe("SharedQueueModule", () => {
  const telemetry = { tracer: {} } as unknown as Telemetry

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe("forRoot", () => {
    it("registers only the default queue without options", () => {
      const registerQueue = jest.spyOn(BullModule, "registerQueue")

      SharedQueueModule.forRoot()

      expect(registerQueue).toHaveBeenCalledWith({ name: DEFAULT_QUEUE })
    })

    it("registers one queue per definition plus the default", () => {
      const registerQueue = jest.spyOn(BullModule, "registerQueue")

      SharedQueueModule.forRoot({
        queues: [{ name: "sync", concurrency: 50 }, { name: "notifications" }],
      })

      expect(registerQueue).toHaveBeenCalledWith(
        { name: DEFAULT_QUEUE },
        { name: "sync" },
        { name: "notifications" },
      )
    })

    it("threads telemetry into every queue registration", () => {
      const registerQueue = jest.spyOn(BullModule, "registerQueue")

      SharedQueueModule.forRoot({ queues: [{ name: "sync" }], telemetry })

      expect(registerQueue).toHaveBeenCalledWith(
        { name: DEFAULT_QUEUE, telemetry },
        { name: "sync", telemetry },
      )
    })

    it("provides one processor class per named queue", () => {
      const dynamicModule = SharedQueueModule.forRoot({
        queues: [{ name: "sync" }, { name: "notifications" }],
      })

      const providerNames = (dynamicModule.providers ?? [])
        .filter(
          (provider): provider is typeof QueueProcessor =>
            typeof provider === "function",
        )
        .map((provider) => provider.name)

      expect(providerNames).toContain("QueueProcessor")
      expect(providerNames).toContain("QueueProcessor_sync")
      expect(providerNames).toContain("QueueProcessor_notifications")
    })

    it("rejects a queue named like the default queue", () => {
      expect(() =>
        SharedQueueModule.forRoot({ queues: [{ name: DEFAULT_QUEUE }] }),
      ).toThrow(/reserved/)
    })

    it("rejects duplicate queue definitions", () => {
      expect(() =>
        SharedQueueModule.forRoot({
          queues: [{ name: "sync" }, { name: "sync" }],
        }),
      ).toThrow(/sync/)
    })
  })

  describe("forRootAsync", () => {
    it("registers queues with a telemetry-forwarding factory", () => {
      const registerQueueAsync = jest.spyOn(BullModule, "registerQueueAsync")

      SharedQueueModule.forRootAsync({
        queues: [{ name: "sync" }],
        useFactory: () => ({ telemetry }),
      })

      const configs = registerQueueAsync.mock.calls[0]
      expect(configs.map((config) => config.name)).toEqual([
        DEFAULT_QUEUE,
        "sync",
      ])

      for (const config of configs) {
        expect(config.useFactory!({ telemetry })).toEqual({ telemetry })
        expect(config.useFactory!(undefined)).toEqual({})
        expect(config.useFactory!({})).toEqual({})
      }
    })
  })

  describe("wiring", () => {
    const createMockQueue = () =>
      ({
        add: jest.fn(),
        addBulk: jest.fn(),
        getActive: jest.fn().mockResolvedValue([]),
        getJobSchedulers: jest.fn().mockResolvedValue([]),
        removeJobScheduler: jest.fn(),
        upsertJobScheduler: jest.fn(),
      }) as unknown as Queue

    const compileModule = async (
      dynamicModule: ReturnType<typeof SharedQueueModule.forRoot>,
      queueNames: string[],
    ) => {
      let builder = Test.createTestingModule({ imports: [dynamicModule] })
      for (const name of queueNames) {
        builder = builder
          .overrideProvider(getQueueToken(name))
          .useValue(createMockQueue())
      }
      return builder.compile()
    }

    it("resolves QueueService and per-queue processors with forRoot", async () => {
      const dynamicModule = SharedQueueModule.forRoot({
        queues: [{ name: "sync" }],
      })
      const testingModule = await compileModule(dynamicModule, [
        DEFAULT_QUEUE,
        "sync",
      ])

      expect(testingModule.get(QueueService)).toBeInstanceOf(QueueService)
      expect(testingModule.get(QueueProcessor)).toBeInstanceOf(QueueProcessor)

      const namedProcessorClass = (dynamicModule.providers ?? []).find(
        (provider) =>
          typeof provider === "function" &&
          provider.name === "QueueProcessor_sync",
      ) as typeof QueueProcessor

      expect(testingModule.get(namedProcessorClass)).toBeDefined()
    })

    it("resolves QueueService and per-queue processors with forRootAsync", async () => {
      const dynamicModule = SharedQueueModule.forRootAsync({
        queues: [{ name: "sync" }],
        useFactory: () => ({}),
      })
      const testingModule = await compileModule(dynamicModule, [
        DEFAULT_QUEUE,
        "sync",
      ])

      expect(testingModule.get(QueueService)).toBeInstanceOf(QueueService)
      expect(testingModule.get(QueueProcessor)).toBeInstanceOf(QueueProcessor)
    })
  })
})
