# Observability Module — `@lyrolab/nest-shared/observability`

OpenTelemetry bootstrap for NestJS services: traces, metrics and logs exported over OTLP/gRPC to the platform collector.

## What Is This?

`startTelemetry()` builds and starts a `NodeSDK` with:

- traces through a `BatchSpanProcessor`, after any `extraSpanProcessors` (e.g., Langfuse)
- metrics through a `PeriodicExportingMetricReader`, exported with **DELTA** temporality for every instrument, which the collector's `deltatocumulative` processor expects
- logs through a `BatchLogRecordProcessor`
- Node auto-instrumentations, unless `instrumentations` is given
- a resource with `service.name`, `service.instance.id` and `deployment.environment.name`

It returns the SDK and a bounded, idempotent `shutdown()`.

## How Do I Use It?

Start telemetry in a file imported first in `main.ts`, so instrumentations patch modules before they load:

```typescript
// src/config/observability/tracer.ts
import { startTelemetry } from "@lyrolab/nest-shared/observability"

export const telemetry = startTelemetry({ serviceName: "timecalendar" })
```

```typescript
// src/main.ts
import "./config/observability/tracer"
import { NestFactory } from "@nestjs/core"
```

### Extra span processors

```typescript
import { LangfuseSpanProcessor } from "@langfuse/otel"
import { startTelemetry } from "@lyrolab/nest-shared/observability"

export const telemetry = startTelemetry({
  serviceName: "lyrochat",
  extraSpanProcessors: [new LangfuseSpanProcessor()],
})
```

### Custom instrumentations

```typescript
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"

startTelemetry({
  serviceName: "timecalendar",
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-fs": { enabled: false },
    }),
  ],
})
```

### Shutdown

Flush telemetry when Nest shuts down. `shutdown()` resolves after the SDK has flushed or after `shutdownTimeoutMs` (default 5000), whichever comes first, and only shuts the SDK down once.

```typescript
import { BeforeApplicationShutdown, Injectable } from "@nestjs/common"
import { telemetry } from "./tracer"

@Injectable()
export class ObservabilityLifecycleService
  implements BeforeApplicationShutdown
{
  beforeApplicationShutdown() {
    return telemetry.shutdown()
  }
}
```

## Options

| Option                | Default                           | Description                                  |
| --------------------- | --------------------------------- | -------------------------------------------- |
| `serviceName`         | —                                 | `service.name` resource attribute            |
| `extraSpanProcessors` | `[]`                              | Span processors run before the OTLP exporter |
| `instrumentations`    | `[getNodeAutoInstrumentations()]` | Instrumentations registered by the SDK       |
| `shutdownTimeoutMs`   | `5000`                            | Upper bound on `shutdown()`                  |

## Environment Variables

| Variable            | Default                 | Description                                                          |
| ------------------- | ----------------------- | -------------------------------------------------------------------- |
| `OTEL_ENABLED`      | enabled                 | `false`, `0`, `no` or `off` disables telemetry: no SDK, no exporters |
| `OTEL_EXPORTER_URL` | `http://localhost:4317` | OTLP/gRPC endpoint shared by traces, metrics and logs                |
| `APP_STAGE`         | `development`           | `deployment.environment.name` resource attribute                     |
| `HOSTNAME`          | —                       | `service.instance.id`; `unknown` when missing or not a safe hostname |

## Requirements

Peer dependencies: `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-grpc`, `@opentelemetry/exporter-metrics-otlp-grpc`, `@opentelemetry/exporter-logs-otlp-grpc` and `@opentelemetry/auto-instrumentations-node`. Install matching versions of the SDK packages (for example all `0.219.x`).
