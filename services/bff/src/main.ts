import { terminationGraceMs } from "./shutdown.js";
import { startTracing, stopTracing, tracingMiddleware } from "./tracing.js";
import {
  configuredAssistantAgent,
  type AssistantAgent,
} from "./assistant-agent.js";
import { AgentDeviceLookup } from "./agent-device.js";
import { registerAgentRoutes } from "./assistant-agent-routes.js";
import { registerSummaryRoutes } from "./assistant-summary-routes.js";
import { readFileSync } from "node:fs";
import express, { type Response as ExpressResponse } from "express";
import { createClient, createCluster } from "redis";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express5";
import { AuthError, type Principal } from "@greenguard/tenant-auth";
import {
  createMachineControlPlaneVerifier,
  machineAwareVerifier,
} from "@greenguard/tenant-auth/machine-control-plane";
import { startMembershipRuntime } from "@greenguard/membership-client";
import { ProvisioningClient } from "./provisioning.js";
import { createSagaMtlsClient } from "./saga-mtls.js";
import { ReadClient } from "./read-client.js";
import { createDeviceLoader } from "./device-loader.js";
import { AlertClient } from "./alerts.js";
import { NotificationClient } from "./notifications.js";
import { HttpMlOperationsClient } from "./ml-operations.js";
import { BillingClient } from "./billing.js";
import {
  KnowledgeClient,
  parseAssistantQuery,
  type RagOpsSection,
} from "./knowledge.js";
import {
  ASSISTANT_SUGGESTIONS,
  redisAssistantSuggestionStore,
  type AssistantSuggestionStore,
} from "./assistant-suggestions.js";
import type { MlOperationsClient } from "./ml-operations.js";
import { attachSubscriptions } from "./subscriptions.js";
import { LiveFeed, type LiveSubscriber } from "./live-feed.js";
import {
  createApolloServer,
  observeResponseWatermark,
  type BffContext,
} from "./schema.js";
import {
  QueryPolicyError,
  resolvePersistedOperation,
  operations,
} from "./query-policy.js";
import {
  boundedRateCheck,
  redisRateLimiter,
  type RateLimiter,
  type RateStore,
} from "./rate-limit.js";

export interface BffOptions {
  agent?: AssistantAgent;
  agentDevice?: AgentDeviceLookup;
  verify: (authorization: string | undefined) => Promise<Principal>;
  provisioning: ProvisioningClient;
  read?: ReadClient;
  alerts?: AlertClient;
  notifications?: NotificationClient;
  mlOperations?: MlOperationsClient;
  billing?: BillingClient;
  knowledge?: KnowledgeClient;
  assistantSuggestions?: AssistantSuggestionStore;
  server?: ApolloServer<BffContext>;
  rateLimiter?: RateLimiter;
  ready?: () => boolean;
  rateCheckTimeoutMs?: number;
}

const machineReadOperations = new Set<string>([
  operations.deviceCurrent,
  operations.readingById,
  operations.deviceHistory,
  operations.deviceSearch,
  operations.siteDevices,
  operations.readingRollups,
  operations.binReadingsLatest,
  operations.binReadingsTrend,
]);
const UUID_PATH =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUGGESTION_PATH =
  /^\/v1\/assistant\/suggestions\/([A-Za-z0-9_-]{1,64})\/used$/;

function createRateRedis(
  nodes: string[],
  url: string | undefined,
  addressMap?: string,
) {
  const socket = { connectTimeout: 2000 };
  if (nodes.length) {
    const nodeAddressMap: Record<string, { host: string; port: number }> = {};
    for (const pair of (addressMap ?? "").split(",").filter(Boolean)) {
      const [source, destination] = pair.split("=");
      if (!source || !destination) throw new Error("invalid Redis address map");
      const [host, portText] = destination.split(":");
      const port = Number(portText);
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error("invalid Redis address map");
      nodeAddressMap[source] = { host, port };
    }
    return createCluster({
      rootNodes: nodes.map((node) => ({ url: node })),
      defaults: { disableOfflineQueue: true, socket },
      nodeAddressMap,
    });
  }
  if (url) return createClient({ url, disableOfflineQueue: true, socket });
  return null;
}

function sendKnowledgeResult(
  response: ExpressResponse,
  result: {
    status: number;
    body: Record<string, unknown>;
    retryAfter?: number;
  },
) {
  if (
    result.retryAfter !== undefined &&
    Number.isFinite(result.retryAfter) &&
    result.retryAfter > 0
  ) {
    response.setHeader(
      "Retry-After",
      String(Math.min(3600, Math.ceil(result.retryAfter))),
    );
  }
  response.status(result.status).json(result.body);
}

export async function createApp(options: BffOptions) {
  let activeSummaries = 0;
  const tenantSummaries = new Map<string, number>();
  const acquireSummarySlot = (
    principal: Principal,
    response: import("express").Response,
  ): (() => void) | null => {
    const tenantCount = tenantSummaries.get(principal.tenantId) ?? 0;
    if (activeSummaries >= 4 || tenantCount >= 2) {
      response.setHeader("Retry-After", "1");
      response.status(503).json({ code: "summary_capacity_unavailable" });
      return null;
    }
    activeSummaries++;
    tenantSummaries.set(principal.tenantId, tenantCount + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeSummaries--;
      const remaining = (tenantSummaries.get(principal.tenantId) ?? 1) - 1;
      if (remaining > 0) tenantSummaries.set(principal.tenantId, remaining);
      else tenantSummaries.delete(principal.tenantId);
      response.off("finish", release);
      response.off("close", release);
    };
    response.once("finish", release);
    response.once("close", release);
    return release;
  };
  let activePdfDownloads = 0;
  let activePdfUploads = 0;
  const app = express();
  app.use(tracingMiddleware);
  registerAgentRoutes(app, options);
  const server = options.server ?? createApolloServer();
  await server.start();
  app.disable("x-powered-by");
  app.get("/healthz", (_request, response) => {
    response.status(204).end();
  });
  app.get("/readyz", (_request, response) => {
    response.status(options.ready?.() === false ? 503 : 204).end();
  });
  const allowAssistantRate = async (
    principal: Principal,
    query: string,
    response: ExpressResponse,
  ) => {
    if (!options.rateLimiter) return true;
    try {
      const decision = await boundedRateCheck(
        options.rateLimiter.check(principal, { query }),
        options.rateCheckTimeoutMs ?? 1000,
      );
      if (decision.allowed) return true;
      response.setHeader("Retry-After", String(decision.retryAfterSeconds));
      response.status(429).json({ code: "rate_limited" });
    } catch {
      response.status(503).json({ code: "rate_limit_unavailable" });
    }
    return false;
  };
  if (options.knowledge) {
    app.post(
      "/v1/knowledge/query",
      express.json({ limit: "8kb" }),
      async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        let releaseSummary: (() => void) | undefined;
        try {
          const authorization = request.header("Authorization");
          const principal = await options.verify(authorization);
          if (principal.principalType === "service") {
            response.status(403).json({ code: "insufficient_role" });
            return;
          }
          const query = parseAssistantQuery(request.body);
          if (!query) {
            response.status(400).json({ code: "invalid_question" });
            return;
          }
          if (
            !(await allowAssistantRate(principal, "knowledgeQuery", response))
          )
            return;
          if (query.scope?.mode === "document_summary") {
            releaseSummary =
              acquireSummarySlot(principal, response) ?? undefined;
            if (!releaseSummary) return;
          }
          const caller = new AbortController();
          response.once("close", () => {
            if (!response.writableEnded) caller.abort();
          });
          const result = await options.knowledge!.ask(
            principal,
            authorization!,
            query.question,
            query.scope,
            caller.signal,
          );
          sendKnowledgeResult(response, result);
        } catch (error) {
          if (error instanceof AuthError)
            response.status(error.status).json({ code: error.code });
          else {
            console.error("BFF knowledge query unavailable");
            response.status(503).json({ code: "service_unavailable" });
          }
        } finally {
          releaseSummary?.();
        }
      },
    );
    app.get("/v1/rag/ops/:section", async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      try {
        const sections: RagOpsSection[] = [
          "overview",
          "retrieval",
          "documents",
          "evaluations",
          "cache",
          "traces",
        ];
        const section = request.params.section as RagOpsSection;
        if (!sections.includes(section)) {
          response.status(404).json({ code: "not_found" });
          return;
        }
        const authorization = request.header("Authorization");
        const principal = await options.verify(authorization);
        if (
          principal.principalType === "service" ||
          !principal.roles.some(
            (role) => role === "operator" || role === "admin",
          )
        ) {
          response.status(403).json({ code: "insufficient_role" });
          return;
        }
        const result = await options.knowledge!.operations(
          principal,
          authorization!,
          section,
        );
        sendKnowledgeResult(response, result);
      } catch (error) {
        if (error instanceof AuthError)
          response.status(error.status).json({ code: error.code });
        else response.status(503).json({ code: "service_unavailable" });
      }
    });
    app.get("/v1/assistant/conversations", async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      try {
        const authorization = request.header("Authorization");
        const principal = await options.verify(authorization);
        if (principal.principalType === "service") {
          response.status(403).json({ code: "insufficient_role" });
          return;
        }
        if (
          !(await allowAssistantRate(
            principal,
            "assistantConversationList",
            response,
          ))
        )
          return;
        const result = await options.knowledge!.listConversations(
          principal,
          authorization!,
        );
        sendKnowledgeResult(response, result);
      } catch (error) {
        if (error instanceof AuthError)
          response.status(error.status).json({ code: error.code });
        else response.status(503).json({ code: "service_unavailable" });
      }
    });
    app.post(
      "/v1/assistant/conversations",
      express.json({ limit: "8kb" }),
      async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        try {
          const authorization = request.header("Authorization");
          const principal = await options.verify(authorization);
          if (principal.principalType === "service") {
            response.status(403).json({ code: "insufficient_role" });
            return;
          }
          if (
            !(await allowAssistantRate(
              principal,
              "assistantConversationWrite",
              response,
            ))
          )
            return;
          if (
            !request.body ||
            typeof request.body !== "object" ||
            Array.isArray(request.body) ||
            Object.keys(request.body).some((key) => key !== "title") ||
            (request.body.title !== undefined &&
              (typeof request.body.title !== "string" ||
                request.body.title.trim().length < 1 ||
                request.body.title.length > 2000))
          ) {
            response.status(400).json({ code: "invalid_conversation_request" });
            return;
          }
          const result = await options.knowledge!.createConversation(
            principal,
            authorization!,
            request.body.title,
          );
          sendKnowledgeResult(response, result);
        } catch (error) {
          if (error instanceof AuthError)
            response.status(error.status).json({ code: error.code });
          else response.status(503).json({ code: "service_unavailable" });
        }
      },
    );
    app.get("/v1/assistant/conversations/:id", async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      try {
        const id = request.params.id as string;
        if (!UUID_PATH.test(id)) {
          response.status(404).json({ code: "not_found" });
          return;
        }
        const authorization = request.header("Authorization");
        const principal = await options.verify(authorization);
        if (principal.principalType === "service") {
          response.status(403).json({ code: "insufficient_role" });
          return;
        }
        if (
          !(await allowAssistantRate(
            principal,
            "assistantConversationRead",
            response,
          ))
        )
          return;
        const result = await options.knowledge!.getConversation(
          principal,
          authorization!,
          id,
        );
        sendKnowledgeResult(response, result);
      } catch (error) {
        if (error instanceof AuthError)
          response.status(error.status).json({ code: error.code });
        else response.status(503).json({ code: "service_unavailable" });
      }
    });
    app.delete("/v1/assistant/conversations/:id", async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      try {
        const id = request.params.id as string;
        if (!UUID_PATH.test(id)) {
          response.status(404).json({ code: "not_found" });
          return;
        }
        const authorization = request.header("Authorization");
        const principal = await options.verify(authorization);
        if (principal.principalType === "service") {
          response.status(403).json({ code: "insufficient_role" });
          return;
        }
        if (
          !(await allowAssistantRate(
            principal,
            "assistantConversationWrite",
            response,
          ))
        )
          return;
        const result = await options.knowledge!.deleteConversation(
          principal,
          authorization!,
          id,
        );
        sendKnowledgeResult(response, result);
      } catch (error) {
        if (error instanceof AuthError)
          response.status(error.status).json({ code: error.code });
        else response.status(503).json({ code: "service_unavailable" });
      }
    });
    app.post(
      "/v1/assistant/conversations/:id/messages",
      express.json({ limit: "8kb" }),
      async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        let releaseSummary: (() => void) | undefined;
        try {
          const id = request.params.id as string;
          if (!UUID_PATH.test(id)) {
            response.status(404).json({ code: "not_found" });
            return;
          }
          const authorization = request.header("Authorization");
          const principal = await options.verify(authorization);
          if (principal.principalType === "service") {
            response.status(403).json({ code: "insufficient_role" });
            return;
          }
          const query = parseAssistantQuery(request.body);
          if (!query) {
            response.status(400).json({ code: "invalid_question" });
            return;
          }
          if (
            !(await allowAssistantRate(principal, "knowledgeQuery", response))
          )
            return;
          if (query.scope?.mode === "document_summary") {
            releaseSummary =
              acquireSummarySlot(principal, response) ?? undefined;
            if (!releaseSummary) return;
          }
          const caller = new AbortController();
          response.once("close", () => {
            if (!response.writableEnded) caller.abort();
          });
          const result = await options.knowledge!.appendConversationMessage(
            principal,
            authorization!,
            id,
            query.question,
            query.scope,
            caller.signal,
          );
          sendKnowledgeResult(response, result);
        } catch (error) {
          if (error instanceof AuthError)
            response.status(error.status).json({ code: error.code });
          else response.status(503).json({ code: "service_unavailable" });
        } finally {
          releaseSummary?.();
        }
      },
    );
    registerSummaryRoutes(app, {
      verify: options.verify,
      knowledge: options.knowledge!,
      allow: allowAssistantRate,
    });
    app.get("/v1/assistant/documents", async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      try {
        const authorization = request.header("Authorization");
        const principal = await options.verify(authorization);
        if (principal.principalType === "service") {
          response.status(403).json({ code: "forbidden" });
          return;
        }
        if (
          !(await allowAssistantRate(
            principal,
            "assistantConversationRead",
            response,
          ))
        )
          return;
        sendKnowledgeResult(
          response,
          await options.knowledge!.listAssistantDocuments(
            principal,
            authorization!,
          ),
        );
      } catch (error) {
        if (error instanceof AuthError)
          response.status(error.status).json({ code: error.code });
        else response.status(503).json({ code: "service_unavailable" });
      }
    });
    app.delete("/v1/assistant/documents/:id", async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      try {
        const id = request.params.id as string;
        if (!UUID_PATH.test(id)) {
          response.status(400).json({ code: "invalid_document_id" });
          return;
        }
        const authorization = request.header("Authorization");
        const principal = await options.verify(authorization);
        if (
          principal.principalType === "service" ||
          !principal.roles.some(
            (role) => role === "operator" || role === "admin",
          )
        ) {
          response.status(403).json({ code: "forbidden" });
          return;
        }
        if (!(await allowAssistantRate(principal, "knowledgeUpload", response)))
          return;
        sendKnowledgeResult(
          response,
          await options.knowledge!.deleteAssistantDocument(
            principal,
            authorization!,
            id,
          ),
        );
      } catch (error) {
        if (error instanceof AuthError)
          response.status(error.status).json({ code: error.code });
        else response.status(503).json({ code: "service_unavailable" });
      }
    });
    app.post(
      "/v1/assistant/documents/:id",
      async (request, response, next) => {
        try {
          if (!UUID_PATH.test(request.params.id as string)) {
            response.status(400).json({ code: "invalid_document_id" });
            return;
          }
          const principal = await options.verify(
            request.header("Authorization"),
          );
          if (
            principal.principalType === "service" ||
            !principal.roles.some(
              (role) => role === "operator" || role === "admin",
            )
          ) {
            response.status(403).json({ code: "insufficient_role" });
            return;
          }
          const length = request.header("Content-Length");
          if (
            length !== undefined &&
            (!/^[0-9]+$/.test(length) || Number(length) > 25 * 1024 * 1024)
          ) {
            response.status(413).json({ code: "pdf_too_large" });
            return;
          }
          if (
            !(await allowAssistantRate(principal, "knowledgeUpload", response))
          )
            return;
          if (activePdfUploads >= 4) {
            response.setHeader("Retry-After", "1");
            response.status(429).json({ code: "upload_concurrency_limit" });
            return;
          }
          activePdfUploads++;
          let released = false;
          const release = () => {
            if (!released) {
              released = true;
              activePdfUploads--;
            }
          };
          response.once("finish", release);
          response.once("close", release);
          response.locals.assistantUploadPrincipal = principal;
          next();
        } catch (error) {
          if (error instanceof AuthError)
            response.status(error.status).json({ code: error.code });
          else response.status(503).json({ code: "service_unavailable" });
        }
      },
      express.raw({ type: "application/pdf", limit: "25mb" }),
      async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        try {
          const id = request.params.id as string;
          const authorization = request.header("Authorization");
          const principal = response.locals
            .assistantUploadPrincipal as Principal;
          if (
            principal.principalType === "service" ||
            !principal.roles.some(
              (role) => role === "operator" || role === "admin",
            )
          ) {
            response.status(403).json({ code: "insufficient_role" });
            return;
          }
          if (
            request
              .header("Content-Type")
              ?.split(";", 1)[0]
              ?.trim()
              .toLowerCase() !== "application/pdf" ||
            !Buffer.isBuffer(request.body) ||
            request.body.length < 5 ||
            request.body.subarray(0, 5).toString("ascii") !== "%PDF-"
          ) {
            response.status(415).json({ code: "pdf_required" });
            return;
          }
          const result = await options.knowledge!.uploadAssistantPdf(
            principal,
            authorization!,
            id,
            request.body,
            request.header("X-PDF-Filename"),
          );
          sendKnowledgeResult(response, result);
        } catch (error) {
          if (error instanceof AuthError)
            response.status(error.status).json({ code: error.code });
          else response.status(503).json({ code: "service_unavailable" });
        }
      },
    );
    app.get(
      "/v1/assistant/documents/:id/versions/:version/:source",
      async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        try {
          const id = request.params.id as string;
          const version = Number(request.params.version);
          if (
            !UUID_PATH.test(id) ||
            !/^[1-9][0-9]*$/.test(request.params.version as string) ||
            !Number.isSafeInteger(version) ||
            version > 2147483647 ||
            !["source", "source-info"].includes(request.params.source as string)
          ) {
            response.status(404).json({ code: "not_found" });
            return;
          }
          const authorization = request.header("Authorization");
          const principal = await options.verify(authorization);
          if (principal.principalType === "service") {
            response.status(403).json({ code: "insufficient_role" });
            return;
          }
          if (
            !(await allowAssistantRate(
              principal,
              "assistantConversationRead",
              response,
            ))
          )
            return;
          if (request.params.source === "source") {
            if (activePdfDownloads >= 2) {
              response.status(503).json({ code: "service_unavailable" });
              return;
            }
            activePdfDownloads += 1;
            let released = false;
            const release = () => {
              if (!released) {
                released = true;
                activePdfDownloads -= 1;
              }
            };
            response.once("finish", release);
            response.once("close", release);
          }
          const caller = new AbortController();
          response.once("close", () => {
            if (!response.writableEnded) caller.abort();
          });
          const result = await options.knowledge!.documentSource(
            principal,
            authorization!,
            id,
            version,
            request.params.source === "source-info",
            caller.signal,
          );
          if ("pdf" in result && result.pdf) {
            response.setHeader("Content-Type", "application/pdf");
            response.setHeader("Content-Disposition", result.disposition!);
            response.status(200).send(result.pdf);
          } else sendKnowledgeResult(response, result);
        } catch (error) {
          if (error instanceof AuthError)
            response.status(error.status).json({ code: error.code });
          else response.status(503).json({ code: "service_unavailable" });
        }
      },
    );
    app.get(
      "/v1/assistant/documents/:id/versions/1",
      async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        try {
          const id = request.params.id as string;
          if (!UUID_PATH.test(id)) {
            response.status(404).json({ code: "not_found" });
            return;
          }
          const authorization = request.header("Authorization");
          const principal = await options.verify(authorization);
          if (principal.principalType === "service") {
            response.status(403).json({ code: "insufficient_role" });
            return;
          }
          if (
            !(await allowAssistantRate(
              principal,
              "assistantConversationRead",
              response,
            ))
          )
            return;
          const result = await options.knowledge!.assistantDocumentStatus(
            principal,
            authorization!,
            id,
          );
          sendKnowledgeResult(response, result);
        } catch (error) {
          if (error instanceof AuthError)
            response.status(error.status).json({ code: error.code });
          else response.status(503).json({ code: "service_unavailable" });
        }
      },
    );
  }
  app.get("/v1/assistant/suggestions", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    let stage: "verify" | "rate_limit" | "list" = "verify";
    try {
      const principal = await options.verify(request.header("Authorization"));
      if (principal.principalType === "service") {
        response.status(403).json({ code: "insufficient_role" });
        return;
      }
      if (!options.assistantSuggestions) {
        response
          .status(503)
          .json({ code: "assistant_suggestions_unavailable" });
        return;
      }
      stage = "rate_limit";
      if (options.rateLimiter) {
        const decision = await boundedRateCheck(
          options.rateLimiter.check(principal, {
            query: "assistantSuggestionList",
          }),
          options.rateCheckTimeoutMs ?? 1000,
        );
        if (!decision.allowed) {
          response.setHeader("Retry-After", String(decision.retryAfterSeconds));
          response.status(429).json({ code: "rate_limited" });
          return;
        }
      }
      stage = "list";
      response.json({
        suggestions: await options.assistantSuggestions.list(
          principal.tenantId,
        ),
      });
    } catch (error) {
      if (error instanceof AuthError)
        response.status(error.status).json({ code: error.code });
      else {
        console.error("Assistant suggestions request failed", {
          stage,
          errorType: error instanceof Error ? error.name : typeof error,
        });
        response
          .status(503)
          .json({ code: "assistant_suggestions_unavailable" });
      }
    }
  });
  app.post(
    SUGGESTION_PATH,
    express.json({ limit: "1kb" }),
    async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      try {
        const match = SUGGESTION_PATH.exec(request.path);
        const suggestionId = match?.[1] ?? "";
        if (!ASSISTANT_SUGGESTIONS.some((item) => item.id === suggestionId)) {
          response.status(404).json({ code: "not_found" });
          return;
        }
        const authorization = request.header("Authorization");
        const principal = await options.verify(authorization);
        if (principal.principalType === "service") {
          response.status(403).json({ code: "insufficient_role" });
          return;
        }
        const usageBody = request.body ?? {};
        if (
          !usageBody ||
          typeof usageBody !== "object" ||
          Array.isArray(usageBody) ||
          Object.keys(usageBody).length
        ) {
          response.status(400).json({ code: "invalid_suggestion_usage" });
          return;
        }
        if (!options.knowledge || !options.assistantSuggestions) {
          response
            .status(503)
            .json({ code: "assistant_suggestions_unavailable" });
          return;
        }
        const eventId = request.header("Idempotency-Key") ?? undefined;
        if (eventId && !UUID_PATH.test(eventId)) {
          response.status(400).json({ code: "invalid_idempotency_key" });
          return;
        }
        if (options.rateLimiter) {
          const decision = await boundedRateCheck(
            options.rateLimiter.check(principal, {
              query: "assistantSuggestionUsage",
            }),
            options.rateCheckTimeoutMs ?? 1000,
          );
          if (!decision.allowed) {
            response.setHeader(
              "Retry-After",
              String(decision.retryAfterSeconds),
            );
            response.status(429).json({ code: "rate_limited" });
            return;
          }
        }
        const result = await options.knowledge.recordSuggestionUsage(
          principal,
          authorization!,
          suggestionId,
          eventId,
        );
        if (result.status < 200 || result.status >= 300) {
          sendKnowledgeResult(response, result);
          return;
        }
        try {
          await options.assistantSuggestions.recordUsage(
            principal.tenantId,
            suggestionId,
          );
        } catch {
          console.warn(
            "Assistant suggestion ranking update unavailable; durable usage event accepted",
          );
        }
        response.status(202).json({ recorded: true });
      } catch (error) {
        if (error instanceof AuthError)
          response.status(error.status).json({ code: error.code });
        else
          response
            .status(503)
            .json({ code: "assistant_suggestions_unavailable" });
      }
    },
  );
  app.use(
    "/graphql",
    (request, response, next) => {
      const controller = new AbortController();
      response.locals.readDeadline = Date.now() + 8000;
      response.locals.readSignal = controller.signal;
      const aborted = () => controller.abort();
      const closed = () => {
        if (!response.writableFinished) controller.abort();
        cleanup();
      };
      const cleanup = () => {
        request.off("aborted", aborted);
        response.off("close", closed);
      };
      request.once("aborted", aborted);
      response.once("close", closed);
      response.once("finish", cleanup);
      next();
    },
    express.json({ limit: "32kb" }),
    async (request, response, next) => {
      try {
        const principal = await options.verify(request.header("Authorization"));
        if (
          (response.locals.readSignal as AbortSignal).aborted ||
          Date.now() >= (response.locals.readDeadline as number)
        ) {
          if (!response.destroyed)
            response.status(504).json({ code: "read_timeout" });
          return;
        }
        response.locals.principal = principal;
        next();
      } catch (error) {
        if (error instanceof AuthError) {
          response.status(error.status).json({ code: error.code });
        } else {
          next(error);
        }
      }
    },
    (request, response, next) => {
      try {
        request.body = resolvePersistedOperation(request.body);
        if (
          (response.locals.principal as Principal).principalType ===
            "service" &&
          !machineReadOperations.has(
            (request.body as Record<string, unknown>).query as string,
          )
        ) {
          response.status(403).json({ code: "insufficient_role" });
          return;
        }
        next();
      } catch (error) {
        if (error instanceof QueryPolicyError) {
          response.status(400).json({ code: error.code });
        } else {
          next(error);
        }
      }
    },
    async (request, response, next) => {
      if (!options.rateLimiter) return next();
      try {
        const decision = await boundedRateCheck(
          options.rateLimiter.check(
            response.locals.principal as Principal,
            request.body as Record<string, unknown>,
          ),
          options.rateCheckTimeoutMs ?? 1000,
        );
        if (!decision.allowed) {
          response.setHeader("Retry-After", String(decision.retryAfterSeconds));
          response.status(429).json({ code: "rate_limited" });
          return;
        }
        next();
      } catch (error) {
        console.error("BFF rate limiter unavailable", error);
        response.status(503).json({ code: "rate_limit_unavailable" });
      }
    },
    expressMiddleware(server, {
      context: async ({ req, res }): Promise<BffContext> => {
        const authorization = req.header("Authorization") ?? "";
        const context: BffContext = {
          principal: res.locals.principal as Principal,
          authorization,
          traceparent: req.header("traceparent"),
          readDeadline: res.locals.readDeadline as number,
          readSignal: res.locals.readSignal as AbortSignal,
          provisioning: options.provisioning,
          read: options.read,
          alerts: options.alerts,
          notifications: options.notifications,
          mlOperations: options.mlOperations,
          billing: options.billing,
        };
        context.deviceLoader = options.read
          ? createDeviceLoader(
              options.read,
              authorization,
              context.principal.tenantId,
              (token) => observeResponseWatermark(context, token),
              { deadline: context.readDeadline, signal: context.readSignal },
            )
          : undefined;
        return context;
      },
    }),
  );
  return { app, server };
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  if (!process.env.SAGA_API_URL) throw new Error("SAGA_API_URL is required");
  const verifier = await startMembershipRuntime(
    (key) => process.env[key],
    (path) => readFileSync(path, "utf8"),
    "bff",
  );
  const machine =
    process.env.CONTROL_PLANE_URL && process.env.CONTROL_LOOKUP_TOKEN
      ? createMachineControlPlaneVerifier({
          endpoint: process.env.CONTROL_PLANE_URL,
          lookupToken: process.env.CONTROL_LOOKUP_TOKEN,
        })
      : undefined;
  const verify = machineAwareVerifier(
    verifier.verify,
    machine,
    "read:telemetry",
  );
  const sagaMtls = createSagaMtlsClient(process.env, process.env.SAGA_API_URL!);
  const rateNodes = (process.env.BFF_RATE_REDIS_CLUSTER_NODES ?? "")
    .split(",")
    .map((node) => node.trim())
    .filter(Boolean);
  const rateRedis = createRateRedis(rateNodes, process.env.BFF_RATE_REDIS_URL);
  if (process.env.NODE_ENV === "production" && rateNodes.length === 0)
    throw new Error("BFF_RATE_REDIS_CLUSTER_NODES is required in production");
  if (!rateRedis && process.env.BFF_ALLOW_NO_RATE_LIMIT !== "true")
    throw new Error(
      "Redis rate limiter is required; set BFF_ALLOW_NO_RATE_LIMIT=true only for local development",
    );
  const rateLimiter = rateRedis
    ? redisRateLimiter(rateRedis as RateStore)
    : undefined;
  const assistantSuggestions = rateRedis
    ? redisAssistantSuggestionStore(rateRedis as RateStore)
    : undefined;
  let rateReady = !rateRedis;
  if (rateRedis) {
    rateRedis.on("error", (error) => {
      rateReady = false;
      console.error("BFF Redis error", error);
    });
    if (rateNodes.length > 0) {
      rateRedis.on("connect", () => {
        rateReady = true;
      });
      rateRedis.on("disconnect", () => {
        rateReady = false;
      });
    } else {
      rateRedis.on("ready", () => {
        rateReady = true;
      });
      rateRedis.on("end", () => {
        rateReady = false;
      });
      rateRedis.on("reconnecting", () => {
        rateReady = false;
      });
    }
    await rateRedis.connect();
    rateReady = true;
  }
  const liveNodes = (
    process.env.BFF_LIVE_REDIS_CLUSTER_NODES ??
    process.env.READ_REDIS_CLUSTER_NODES ??
    ""
  )
    .split(",")
    .map((node) => node.trim())
    .filter(Boolean);
  const liveRedis = createRateRedis(
    liveNodes,
    process.env.BFF_LIVE_REDIS_URL ?? process.env.READ_REDIS_URL,
    process.env.BFF_LIVE_REDIS_NODE_ADDRESS_MAP ??
      process.env.READ_REDIS_NODE_ADDRESS_MAP,
  );
  if (process.env.NODE_ENV === "production" && !liveRedis)
    throw new Error("BFF_LIVE_REDIS_CLUSTER_NODES is required in production");
  const liveFeed = liveRedis
    ? new LiveFeed(liveRedis as unknown as LiveSubscriber, liveNodes.length > 0)
    : undefined;
  if (liveRedis) {
    try {
      void liveRedis.connect().catch((error) => {
        console.error(
          "BFF live Redis unavailable; using bounded fallback polling",
          error,
        );
      });
      await liveFeed?.start();
    } catch (error) {
      console.error(
        "BFF live Redis unavailable; using bounded fallback polling",
        error,
      );
    }
  }
  let stopping = false;
  const { app, server } = await createApp({
    agent: await configuredAssistantAgent(),
    agentDevice: process.env.DEVICE_API_URL
      ? new AgentDeviceLookup(process.env.DEVICE_API_URL)
      : undefined,
    verify,
    provisioning: new ProvisioningClient(
      process.env.SAGA_API_URL!,
      sagaMtls?.fetcher,
    ),
    read: process.env.READ_API_URL
      ? new ReadClient(process.env.READ_API_URL)
      : undefined,
    alerts: process.env.ALERT_API_URL
      ? new AlertClient(process.env.ALERT_API_URL)
      : undefined,
    notifications: process.env.JOBS_NOTIFICATION_API_URL
      ? new NotificationClient(
          process.env.JOBS_NOTIFICATION_API_URL,
          process.env.NOTIFICATION_DELIVERY_API_URL,
        )
      : undefined,
    mlOperations: process.env.ML_OPERATIONS_URL
      ? new HttpMlOperationsClient(
          process.env.ML_OPERATIONS_URL,
          async (input, init) =>
            fetch(input, {
              ...init,
              headers: {
                ...(init?.headers ?? {}),
                ...(process.env.ML_OPERATIONS_TOKEN
                  ? { "X-Internal-Token": process.env.ML_OPERATIONS_TOKEN }
                  : {}),
              },
            }),
        )
      : undefined,
    billing: process.env.BILLING_API_URL
      ? new BillingClient(process.env.BILLING_API_URL)
      : undefined,
    knowledge: process.env.KNOWLEDGE_API_URL
      ? new KnowledgeClient(process.env.KNOWLEDGE_API_URL)
      : undefined,
    assistantSuggestions,
    rateLimiter,
    ready: () => !stopping && rateReady,
  });
  startTracing("bff");
  const listener = app.listen(Number(process.env.BFF_PORT ?? "4000"));
  const stopSubscriptions = process.env.READ_API_URL
    ? attachSubscriptions(listener, {
        verify: verifier.verify,
        read: new ReadClient(process.env.READ_API_URL),
        feed: liveFeed,
        rateLimiter,
      })
    : undefined;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const parsedDrain = Number(process.env.BFF_DRAIN_MS ?? 1000);
    const drainMs = Number.isFinite(parsedDrain)
      ? Math.max(0, Math.min(10_000, parsedDrain))
      : 1000;
    const deadline = setTimeout(
      () => process.exit(1),
      terminationGraceMs(process.env.BFF_TERMINATION_GRACE_MS),
    );
    deadline.unref();
    setTimeout(async () => {
      await stopSubscriptions?.();
      listener.close(async (listenerError) => {
        const results = await Promise.allSettled([
          stopTracing(),
          server.stop(),
          rateRedis?.quit(),
          liveRedis?.quit(),
          sagaMtls?.close(),
          verifier.close(),
        ]);
        if (listenerError)
          console.error("BFF listener shutdown failed", listenerError);
        for (const result of results)
          if (result.status === "rejected")
            console.error("BFF shutdown failed", result.reason);
        process.exitCode =
          listenerError ||
          results.some((result) => result.status === "rejected")
            ? 1
            : 0;
        clearTimeout(deadline);
      });
    }, drainMs).unref();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, shutdown);
  }
}
