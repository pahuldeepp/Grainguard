import { AsyncLocalStorage } from "node:async_hooks";
import {
  ROOT_CONTEXT,
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";
import { activeTraceparent, initTracing, type Tracing } from "@greenguard/otel";
import type { RequestHandler } from "express";
const incoming = new AsyncLocalStorage<string | undefined>();
let runtime: Tracing | undefined;
export function startTracing(
  serviceName: string,
  endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  testing?: Tracing,
): void {
  if (testing) {
    runtime = testing;
    return;
  }
  if (!endpoint || runtime) return;
  const u = new URL(endpoint);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (u.protocol !== "https:" &&
      !(
        u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
      ))
  )
    throw new Error("unsafe OTLP endpoint");
  runtime = initTracing({ serviceName, otlpEndpoint: endpoint });
}
export async function stopTracing(): Promise<void> {
  const current = runtime;
  runtime = undefined;
  if (current) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        current.shutdown(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5000);
          timer.unref();
        }),
      ]);
    } catch {
      console.error("tracing shutdown incomplete");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
export function traceHeader(): string | undefined {
  return activeTraceparent() ?? incoming.getStore();
}
export async function operation<T>(
  name: string,
  kind: SpanKind,
  run: () => Promise<T>,
): Promise<T> {
  if (!runtime) return run();
  return runtime.tracer.startActiveSpan(name, { kind }, async (span) => {
    try {
      return await run();
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: "operation failed",
      });
      throw error;
    } finally {
      span.end();
    }
  });
}
const route = (path: string): string | undefined => {
  if (path === "/v1/assistant/agent" || path === "/v1/agent/query")
    return "BFF.agent.query";
  if (/^\/v1\/agent\/conversations(?:\/[^/]+(?:\/messages)?)?$/.test(path))
    return "BFF.agent.conversation";
  if (
    /^\/v1\/advisor\/proposals(?:\/[^/]+(?:\/(?:decision|execution))?)?$/.test(
      path,
    )
  )
    return path.endsWith("/execution")
      ? "BFF.advisor.execution"
      : path.endsWith("/decision")
        ? "BFF.advisor.decision"
        : "BFF.advisor.proposals";
  return undefined;
};
export const tracingMiddleware: RequestHandler = (req, res, next) => {
  const name = route(req.path);
  if (!name) {
    next();
    return;
  }
  const header = req.header("traceparent");
  const valid =
    header &&
    /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-0[01]$/.test(header)
      ? header
      : undefined;
  incoming.run(valid, () => {
    if (!runtime) {
      next();
      return;
    }
    const parent = propagation.extract(
      ROOT_CONTEXT,
      valid ? { traceparent: valid } : {},
    );
    const span = runtime.tracer.startSpan(
      name,
      { kind: SpanKind.SERVER },
      parent,
    );
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      span.setAttribute("http.response.status_code", res.statusCode);
      if (res.statusCode >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    };
    res.once("finish", finish);
    res.once("close", finish);
    context.with(context.active(), () =>
      context.with(importContext(parent, span), next),
    );
  });
};
import { trace, type Context, type Span } from "@opentelemetry/api";
function importContext(parent: Context, span: Span): Context {
  return trace.setSpan(parent, span);
}
export function tracedFetch(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input))
      .pathname;
    const name = path.startsWith("/v1/advisor/")
      ? "BFF.advisor.client"
      : path === "/mcp"
        ? "BFF.mcp.client"
        : path === "/v1/agent/plan"
          ? "BFF.gateway.plan"
          : path === "/v1/agent/respond"
            ? "BFF.gateway.respond"
            : "BFF.downstream.client";
    return operation(name, SpanKind.CLIENT, async () => {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      const parent = traceHeader();
      if (parent) headers.set("traceparent", parent);
      const response = await fetcher(input, { ...init, headers });
      trace
        .getActiveSpan()
        ?.setAttribute("http.response.status_code", response.status);
      if (response.status >= 400)
        trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR });
      return response;
    });
  };
}
export function tracedDelegation<
  T extends { mint: (...args: never[]) => Promise<string> },
>(delegate: T): T {
  return new Proxy(delegate, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return key === "mint"
        ? (...args: Parameters<T["mint"]>) =>
            operation("BFF.delegation.exchange", SpanKind.INTERNAL, () =>
              target.mint(...args),
            )
        : typeof value === "function"
          ? value.bind(target)
          : value;
    },
  });
}
