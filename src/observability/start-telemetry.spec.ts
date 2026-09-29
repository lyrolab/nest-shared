import { logs, metrics, tracing } from "@opentelemetry/sdk-node"
import {
  createBoundedShutdown,
  createMetricExporter,
  createTelemetrySdk,
  isTelemetryEnabled,
  startTelemetry,
} from "./start-telemetry"

type SdkInternals = {
  _resource: { attributes: Record<string, unknown> }
  _tracerProviderConfig: { spanProcessors: tracing.SpanProcessor[] }
  _instrumentations: unknown[]
}

const internals = (sdk: unknown) => sdk as SdkInternals

const inMemoryFactories = () => ({
  trace: jest.fn<tracing.SpanExporter, [string]>(
    () => new tracing.InMemorySpanExporter(),
  ),
  metric: jest.fn<metrics.PushMetricExporter, [string]>(
    () =>
      new metrics.InMemoryMetricExporter(metrics.AggregationTemporality.DELTA),
  ),
  log: jest.fn<logs.LogRecordExporter, [string]>(
    () => new logs.InMemoryLogRecordExporter(),
  ),
})

describe("isTelemetryEnabled", () => {
  it.each([
    [undefined, true],
    ["", true],
    ["true", true],
    ["1", true],
    ["false", false],
    [" FALSE ", false],
    ["0", false],
    ["no", false],
    ["off", false],
  ])("treats OTEL_ENABLED=%p as %p", (value, expected) => {
    expect(isTelemetryEnabled(value)).toBe(expected)
  })
})

describe("createTelemetrySdk", () => {
  it("does not create exporters when telemetry is disabled", () => {
    const factories = inMemoryFactories()

    expect(
      createTelemetrySdk(
        { serviceName: "app" },
        { OTEL_ENABLED: "false" },
        factories,
      ),
    ).toBeUndefined()
    expect(factories.trace).not.toHaveBeenCalled()
    expect(factories.metric).not.toHaveBeenCalled()
    expect(factories.log).not.toHaveBeenCalled()
  })

  it("shares OTEL_EXPORTER_URL across traces, metrics and logs", () => {
    const factories = inMemoryFactories()

    createTelemetrySdk(
      { serviceName: "app" },
      { OTEL_EXPORTER_URL: "http://collector:4317" },
      factories,
    )

    expect(factories.trace).toHaveBeenCalledWith("http://collector:4317")
    expect(factories.metric).toHaveBeenCalledWith("http://collector:4317")
    expect(factories.log).toHaveBeenCalledWith("http://collector:4317")
  })

  it("falls back to the local collector", () => {
    const factories = inMemoryFactories()

    createTelemetrySdk({ serviceName: "app" }, {}, factories)

    expect(factories.trace).toHaveBeenCalledWith("http://localhost:4317")
  })

  it("describes the service, instance and stage in the resource", () => {
    const sdk = createTelemetrySdk(
      { serviceName: "lyrochat" },
      { APP_STAGE: "preprod", HOSTNAME: "lyrochat-backend-abc12" },
      inMemoryFactories(),
    )

    expect(internals(sdk)._resource.attributes).toMatchObject({
      "service.name": "lyrochat",
      "service.instance.id": "lyrochat-backend-abc12",
      "deployment.environment.name": "preprod",
    })
  })

  it("defaults the stage to development and hides unsafe hostnames", () => {
    const sdk = createTelemetrySdk(
      { serviceName: "app" },
      { HOSTNAME: "pod/name" },
      inMemoryFactories(),
    )

    expect(internals(sdk)._resource.attributes).toMatchObject({
      "service.instance.id": "unknown",
      "deployment.environment.name": "development",
    })
  })

  it("runs extra span processors before the OTLP exporter", () => {
    const extra = new tracing.SimpleSpanProcessor(
      new tracing.InMemorySpanExporter(),
    )

    const sdk = createTelemetrySdk(
      { serviceName: "app", extraSpanProcessors: [extra] },
      {},
      inMemoryFactories(),
    )

    const { spanProcessors } = internals(sdk)._tracerProviderConfig
    expect(spanProcessors).toHaveLength(2)
    expect(spanProcessors[0]).toBe(extra)
    expect(spanProcessors[1]).toBeInstanceOf(tracing.BatchSpanProcessor)
  })

  it("uses the given instrumentations", () => {
    const sdk = createTelemetrySdk(
      { serviceName: "app", instrumentations: [] },
      {},
      inMemoryFactories(),
    )

    expect(internals(sdk)._instrumentations).toEqual([])
  })
})

describe("createMetricExporter", () => {
  it("selects DELTA for every instrument type", () => {
    const exporter = createMetricExporter("http://collector:4317")

    for (const instrumentType of Object.values(metrics.InstrumentType)) {
      expect(exporter.selectAggregationTemporality(instrumentType)).toBe(
        metrics.AggregationTemporality.DELTA,
      )
    }
  })
})

describe("startTelemetry", () => {
  const env = process.env

  afterEach(() => {
    process.env = env
  })

  it("starts nothing when OTEL_ENABLED is false", async () => {
    process.env = { ...env, OTEL_ENABLED: "false" }

    const telemetry = startTelemetry({ serviceName: "app" })

    expect(telemetry.sdk).toBeUndefined()
    await expect(telemetry.shutdown()).resolves.toBeUndefined()
  })
})

describe("createBoundedShutdown", () => {
  afterEach(() => jest.useRealTimers())

  it("shuts the SDK down once", async () => {
    jest.useFakeTimers()
    const sdk = { shutdown: jest.fn(() => Promise.resolve()) }
    const shutdown = createBoundedShutdown(sdk)

    await Promise.all([shutdown(), shutdown()])

    expect(sdk.shutdown).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })

  it("is a no-op without an SDK", async () => {
    await expect(createBoundedShutdown(undefined)()).resolves.toBeUndefined()
  })

  it("does not wait forever for an exporter", async () => {
    jest.useFakeTimers()
    const shutdown = createBoundedShutdown(
      { shutdown: jest.fn(() => new Promise<void>(() => undefined)) },
      10,
    )

    const result = shutdown()
    await jest.advanceTimersByTimeAsync(10)

    await expect(result).resolves.toBeUndefined()
  })
})
