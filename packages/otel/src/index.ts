import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Attributes,
  type SpanContext,
  type Tracer,
} from "@opentelemetry/api";
export {
  recordPostgresQueryDuration,
  registerPostgresPool,
  renderPostgresPoolMetrics,
} from "./postgres-metrics.js";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-node";
import type { IncomingMessage, ServerResponse } from "node:http";

interface CommonOptions {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  // Fraction of new traces to record; a sampling decision made by the caller is kept.
  sampleRatio?: number;
}

// Either an OTLP/HTTP collector base URL (for example http://collector:4318) or an
// explicit exporter, which tests use to capture spans in memory.
export type TracingOptions = CommonOptions &
  (
    | { otlpEndpoint: string; spanExporter?: undefined }
    | { spanExporter: SpanExporter; otlpEndpoint?: undefined }
  );

export interface Tracing {
  tracer: Tracer;
  shutdown(): Promise<void>;
}

function otlpExporter(endpoint: string | undefined): SpanExporter {
  const base = endpoint as string;
  const url = new URL("v1/traces", base.endsWith("/") ? base : `${base}/`);
  return new OTLPTraceExporter({ url: url.href });
}

export function initTracing(options: TracingOptions): Tracing {
  const exporter = options.spanExporter ?? otlpExporter(options.otlpEndpoint);
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": options.serviceName,
      "service.version": options.serviceVersion ?? "0.0.0",
      "deployment.environment.name": options.environment ?? "local",
    }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(options.sampleRatio ?? 1),
    }),
    spanProcessors: [
      options.spanExporter
        ? new SimpleSpanProcessor(exporter)
        : new BatchSpanProcessor(exporter),
    ],
  });
  provider.register({ propagator: new W3CTraceContextPropagator() });
  return {
    tracer: provider.getTracer(options.serviceName),
    async shutdown() {
      await provider.shutdown();
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}

// The sampled bit is the only trace flag the platform's event contracts carry.
export function formatTraceparent(spanContext: SpanContext): string {
  const flags = spanContext.traceFlags & 1 ? "01" : "00";
  return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
}

export function activeTraceparent(): string | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext && trace.isSpanContextValid(spanContext)
    ? formatTraceparent(spanContext)
    : undefined;
}

// Bounded, low-cardinality attributes only; never tokens or payload data.
export function annotateActiveSpan(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}

type Next = (error?: unknown) => void;

const ID_SEGMENT =
  /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}|\d{2,}/g;

// Span names must stay low-cardinality, so identifiers in the path become ":id".
export const spanName = (method: string, path: string): string =>
  `${method} ${path.replaceAll(ID_SEGMENT, ":id")}`;

// Continues the caller's W3C trace (or starts one) and holds a server span open for the
// request. The span is the active context for everything the handler awaits.
export function httpTracingMiddleware(tracer: Tracer) {
  return (req: IncomingMessage, res: ServerResponse, next: Next): void => {
    const parent = propagation.extract(ROOT_CONTEXT, req.headers);
    const method = req.method as string;
    const path = (req.url as string).split("?")[0];
    const span = tracer.startSpan(
      spanName(method, path),
      {
        kind: SpanKind.SERVER,
        attributes: { "http.request.method": method, "url.path": path },
      },
      parent,
    );
    res.once("close", () => {
      const status = res.statusCode;
      span.setAttribute("http.response.status_code", status);
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    });
    context.with(trace.setSpan(parent, span), next);
  };
}
