import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isSunset,
  resolveVersion,
  type ApiVersionPolicy,
  type ResolvedVersion,
  type VersionRegistry,
} from "./policy.js";

export type ApiVersionRequest = IncomingMessage & {
  apiVersion?: ResolvedVersion;
  correlationId?: string;
};

type Response = ServerResponse;
type NextFunction = (err?: unknown) => void;

function appendHeader(res: Response, name: string, value: string): void {
  const existing = res.getHeader(name);
  res.setHeader(
    name,
    existing === undefined ? value : `${String(existing)}, ${value}`,
  );
}

function problem(
  req: ApiVersionRequest,
  res: Response,
  status: number,
  body: Record<string, unknown>,
): void {
  const payload = JSON.stringify({
    type: "about:blank",
    ...body,
    status,
    correlation_id: req.correlationId,
  });
  res.statusCode = status;
  res.setHeader("Content-Type", "application/problem+json");
  res.end(payload);
}

function supported(registry: VersionRegistry, now: Date): string[] {
  return registry.versions
    .filter((p: ApiVersionPolicy) => !isSunset(p, now))
    .map((p: ApiVersionPolicy) => p.version);
}

function setDeprecationHeaders(res: Response, policy: ApiVersionPolicy): void {
  if (policy.deprecatedAt) {
    res.setHeader(
      "Deprecation",
      `@${Math.floor(policy.deprecatedAt.getTime() / 1000)}`,
    );
  }
  if (policy.sunsetAt) res.setHeader("Sunset", policy.sunsetAt.toUTCString());
  if (policy.successor) {
    appendHeader(
      res,
      "Link",
      `<urn:api-version:${policy.successor}>; rel="successor-version"`,
    );
  }
  if (policy.documentationUrl) {
    appendHeader(
      res,
      "Link",
      `<${policy.documentationUrl}>; rel="deprecation"`,
    );
  }
}

export function createApiVersionMiddleware(
  registry: VersionRegistry,
  now: () => Date = () => new Date(),
): (req: ApiVersionRequest, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const instant = now();
    const raw: string | string[] | undefined = req.headers["api-version"];
    const result = resolveVersion(
      Array.isArray(raw) ? raw.join(",") : raw,
      registry,
      instant,
    );
    appendHeader(res, "Vary", "API-Version");
    if (result.kind === "unsupported") {
      problem(req, res, 400, {
        title: "Unsupported API version",
        code: "unsupported_api_version",
        detail: "The requested API version is not supported.",
        requested: result.requested,
        supported: supported(registry, instant),
      });
      return;
    }
    if (result.kind === "sunset") {
      const { policy } = result;
      res.setHeader("Sunset", (policy.sunsetAt as Date).toUTCString());
      problem(req, res, 410, {
        title: "API version sunset",
        code: "api_version_sunset",
        detail: `API version ${policy.version} is no longer available.`,
        version: policy.version,
        sunset: (policy.sunsetAt as Date).toISOString(),
        ...(policy.successor ? { successor: policy.successor } : {}),
      });
      return;
    }
    res.setHeader("API-Version", result.resolved.version);
    if (result.resolved.state === "deprecated") {
      setDeprecationHeaders(res, result.resolved.policy);
    }
    req.apiVersion = result.resolved;
    next();
  };
}
