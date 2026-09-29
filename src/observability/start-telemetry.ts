import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc"
import {
  logs,
  metrics,
  NodeSDK,
  NodeSDKConfiguration,
  resources,
  tracing,
} from "@opentelemetry/sdk-node"
import { resolveServiceInstanceId } from "./service-instance"

const DEFAULT_OTLP_ENDPOINT = "http://localhost:4317"
const DEFAULT_APP_STAGE = "development"
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000

export type StartTelemetryOptions = {
  serviceName: string
  extraSpanProcessors?: tracing.SpanProcessor[]
  instrumentations?: NodeSDKConfiguration["instrumentations"]
  shutdownTimeoutMs?: number
}

export type Telemetry = {
  sdk?: NodeSDK
  shutdown: () => Promise<void>
}

export type TelemetryExporterFactories = {
  trace: (url: string) => tracing.SpanExporter
  metric: (url: string) => metrics.PushMetricExporter
  log: (url: string) => logs.LogRecordExporter
}

// The platform collector sums app metrics with `deltatocumulative`, so every
// instrument (UpDownCounters included) must be exported as DELTA.
class DeltaMetricExporter extends OTLPMetricExporter {
  selectAggregationTemporality(): metrics.AggregationTemporality {
    return metrics.AggregationTemporality.DELTA
  }
}

export const createMetricExporter = (url: string): OTLPMetricExporter =>
  new DeltaMetricExporter({ url })

const otlpExporterFactories: TelemetryExporterFactories = {
  trace: (url) => new OTLPTraceExporter({ url }),
  metric: createMetricExporter,
  log: (url) => new OTLPLogExporter({ url }),
}

export const isTelemetryEnabled = (value: string | undefined): boolean =>
  !["false", "0", "no", "off"].includes(value?.trim().toLowerCase() ?? "")

export function createTelemetrySdk(
  options: StartTelemetryOptions,
  env: NodeJS.ProcessEnv = process.env,
  factories: TelemetryExporterFactories = otlpExporterFactories,
): NodeSDK | undefined {
  if (!isTelemetryEnabled(env.OTEL_ENABLED)) return undefined

  const endpoint = env.OTEL_EXPORTER_URL || DEFAULT_OTLP_ENDPOINT
  return new NodeSDK({
    spanProcessors: [
      ...(options.extraSpanProcessors ?? []),
      new tracing.BatchSpanProcessor(factories.trace(endpoint)),
    ],
    metricReader: new metrics.PeriodicExportingMetricReader({
      exporter: factories.metric(endpoint),
    }),
    logRecordProcessors: [
      new logs.BatchLogRecordProcessor(factories.log(endpoint)),
    ],
    instrumentations: options.instrumentations ?? [
      getNodeAutoInstrumentations(),
    ],
    resource: resources.resourceFromAttributes({
      "service.name": options.serviceName,
      "service.instance.id": resolveServiceInstanceId(env.HOSTNAME),
      "deployment.environment.name": env.APP_STAGE || DEFAULT_APP_STAGE,
    }),
  })
}

export function createBoundedShutdown(
  sdk: Pick<NodeSDK, "shutdown"> | undefined,
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
): () => Promise<void> {
  let shutdown: Promise<void> | undefined

  return () => {
    if (!sdk) return Promise.resolve()
    if (shutdown) return shutdown

    let timer: ReturnType<typeof setTimeout> | undefined
    shutdown = Promise.race([
      sdk.shutdown().finally(() => clearTimeout(timer)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
      }),
    ])
    return shutdown
  }
}

export function startTelemetry(options: StartTelemetryOptions): Telemetry {
  const sdk = createTelemetrySdk(options)

  if (sdk) {
    // Diagnostics stay on the console and never enter the application logger,
    // which may itself export through OTel and recurse.
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO)
    sdk.start()
  }

  return {
    sdk,
    shutdown: createBoundedShutdown(sdk, options.shutdownTimeoutMs),
  }
}
