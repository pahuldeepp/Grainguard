import type { Express, Response } from "express";
import express from "express";
import { AuthError, type Principal } from "@greenguard/tenant-auth";
import type { KnowledgeClient } from "./knowledge.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function registerSummaryRoutes(
  app: Express,
  options: {
    verify: (authorization?: string) => Promise<Principal>;
    knowledge: KnowledgeClient;
    allow: (
      principal: Principal,
      query: string,
      response: Response,
    ) => Promise<boolean>;
  },
) {
  for (const method of ["get", "post", "delete"] as const) {
    const path =
      method === "post"
        ? "/v1/assistant/summary-jobs"
        : "/v1/assistant/summary-jobs/:id";
    app[method](
      path,
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
          const id = (request.params as Record<string, string>).id;
          let body: Record<string, unknown> | undefined;
          if (method === "post") {
            const b = request.body;
            if (
              !b ||
              typeof b !== "object" ||
              Array.isArray(b) ||
              Object.keys(b).some(
                (k) =>
                  ![
                    "document_id",
                    "document_version",
                    "question",
                    "idempotency_key",
                  ].includes(k),
              ) ||
              typeof b.document_id !== "string" ||
              !UUID.test(b.document_id) ||
              !Number.isSafeInteger(b.document_version) ||
              b.document_version < 1 ||
              b.document_version > 2147483647 ||
              typeof b.question !== "string" ||
              b.question.trim().length < 4 ||
              b.question.length > 2000 ||
              typeof b.idempotency_key !== "string" ||
              !UUID.test(b.idempotency_key)
            ) {
              response.status(400).json({ code: "invalid_question" });
              return;
            }
            body = b;
          } else if (!id || !UUID.test(id)) {
            response.status(404).json({ code: "not_found" });
            return;
          }
          if (
            !(await options.allow(
              principal,
              method === "get"
                ? "assistantConversationRead"
                : "assistantConversationWrite",
              response,
            ))
          )
            return;
          const result = await options.knowledge.summaryJob(
            principal,
            authorization!,
            method.toUpperCase() as "POST" | "GET" | "DELETE",
            id,
            body,
          );
          if (result.retryAfter)
            response.setHeader("Retry-After", result.retryAfter);
          response.status(result.status).json(result.body);
        } catch (error) {
          if (error instanceof AuthError)
            response.status(error.status).json({ code: error.code });
          else response.status(503).json({ code: "service_unavailable" });
        }
      },
    );
  }
}
