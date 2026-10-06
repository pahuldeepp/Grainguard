import { useQuery } from "@tanstack/react-query";
import { NavLink } from "react-router";
import { PageHeader, Banner, EmptyState, ErrorState, Loading } from "./ui";
import {
  ragOperationsSections,
  type RagOperationsApi,
  type RagOperationsSection,
} from "./rag-operations-api";

const labels: Record<RagOperationsSection, string> = {
  overview: "Overview",
  retrieval: "Retrieval",
  documents: "Documents",
  evaluations: "Evaluations",
  cache: "Cache",
  traces: "Traces",
};

function safeText(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return String(value);
  return "Unavailable";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeSummary(
  section: RagOperationsSection,
  data: Record<string, unknown>,
) {
  const items = Array.isArray(data.items) ? data.items : [];
  const fields =
    section === "cache"
      ? [
          ["Redis", data.redis],
          ["Retrieval hits", data.retrieval_hits],
          ["Retrieval misses", data.retrieval_misses],
          ["Embedding hits", data.embedding_hits],
          ["Embedding misses", data.embedding_misses],
          [
            "Hit ratio",
            typeof data.hit_ratio === "number"
              ? `${(data.hit_ratio * 100).toFixed(1)}%`
              : "No lookups yet",
          ],
          ["Retrieval TTL (seconds)", data.retrieval_ttl_seconds],
          ["Embedding TTL (seconds)", data.embedding_ttl_seconds],
          ["Window", data.window],
          ["Source", data.source],
        ]
      : section === "evaluations"
        ? [
            ["Dataset", data.dataset_version],
            ["Cases", data.case_count],
            ["Passed controls", data.passed_count],
            ["Gate passed", data.passed],
            ["Report SHA-256", data.report_sha256],
            ["Report updated", data.window],
            ["Source", data.source],
          ]
        : section === "overview"
          ? [
              ["Service status", data.health],
              ["Recent requests", data.query_count],
              [
                "Success rate",
                typeof data.success_rate === "number"
                  ? `${(data.success_rate * 100).toFixed(1)}%`
                  : undefined,
              ],
              [
                "Request latency p95 (ms)",
                record(data.latency_ms).p95 ?? data.latency_p95_ms,
              ],
              ["Embedding model", data.embedding_model],
              ["Reranker model", data.reranker_model],
              ["Answer model", data.answer_model],
              ["Index version", data.index_version],
              ["Window", data.telemetry_window],
              ["Source", data.metrics_source],
            ]
          : [
              ["Records shown", Math.min(items.length, 100)],
              [
                "Source",
                data.source ??
                  (section === "documents"
                    ? "Authorized document versions"
                    : undefined),
              ],
              [
                "Window",
                data.window ??
                  (section === "retrieval" || section === "traces"
                    ? "Up to 100 recent requests in this service process"
                    : undefined),
              ],
            ];
  return (
    <dl className="rag-summary">
      {fields.map(([label, value]) => (
        <div className="rag-summary-item" key={String(label)}>
          <dt>{String(label)}</dt>
          <dd>{safeText(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function safeRows(section: RagOperationsSection, items: unknown[]) {
  const columns =
    section === "documents"
      ? [
          ["Document", "document_id"],
          ["Version", "version"],
          ["Current version", "current_version"],
          ["Status", "status"],
          ["Chunks", "chunk_count"],
          ["Created", "created_at"],
        ]
      : [
          ["Request", "request_id"],
          ["Time", "at"],
          ["Status", "status"],
          ["Latency (ms)", "latency_ms"],
          ["Citations", "citation_count"],
        ];
  return (
    <div style={{ overflowX: "auto" }}>
      <table aria-label={`${labels[section]} records`}>
        <thead>
          <tr>
            {columns.map(([label]) => (
              <th scope="col" key={label}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.slice(0, 100).map((item, index) => {
            const row = record(item);
            return (
              <tr key={index}>
                {columns.map(([label, key]) => {
                  let value = row[key];
                  if (key === "citation_count")
                    value = Array.isArray(row.citations)
                      ? row.citations.length
                      : 0;
                  if (
                    key === "at" &&
                    typeof value === "number" &&
                    Number.isFinite(value)
                  ) {
                    const date = new Date(value * 1000);
                    value = Number.isNaN(date.getTime())
                      ? undefined
                      : date.toISOString();
                  }
                  return <td key={label}>{safeText(value)}</td>;
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function RagOperationsView({
  api,
  sessionId,
  section,
}: Readonly<{
  api: RagOperationsApi | null;
  sessionId?: string;
  section: RagOperationsSection;
}>) {
  const query = useQuery({
    queryKey: ["rag-operations", section, sessionId],
    queryFn: ({ signal }) => api!.snapshot(section, signal),
    enabled: Boolean(api && sessionId),
    retry: false,
    refetchInterval: 15_000,
    gcTime: 0,
  });

  return (
    <section className="read-view" aria-labelledby="rag-operations-title">
      <PageHeader id="rag-operations-title" title={`RAG ${labels[section]}`}>
        Operator view · metrics exclude prompts, answers, and credentials
      </PageHeader>
      <nav aria-label="RAG operations" className="rag-section-nav">
        {ragOperationsSections.map((item) => (
          <NavLink
            key={item}
            to={`/rag/${item}`}
            end={item === "overview"}
            aria-current={section === item ? "page" : undefined}
          >
            {labels[item]}
          </NavLink>
        ))}
      </nav>
      {!api || !sessionId ? (
        <EmptyState title="Sign in to view RAG operations." />
      ) : query.isPending ? (
        <Loading label="Loading RAG operations…" rows={3} />
      ) : query.isError ? (
        <>
          <ErrorState
            message={
              query.error instanceof Error &&
              query.error.message === "operator_access_required"
                ? "RAG operations are available to operators and administrators."
                : "RAG telemetry is not connected to this dashboard yet. The page is ready; the authenticated operations API is unavailable."
            }
            onRetry={() => void query.refetch()}
          />
          <section className="section" aria-label="RAG dashboard sections">
            <EmptyState title={`${labels[section]} data is unavailable.`}>
              No synthetic or placeholder production metrics are shown.
            </EmptyState>
          </section>
        </>
      ) : (
        <section className="section" aria-label={`${labels[section]} metrics`}>
          {query.data?.available === false && (
            <Banner kind="warning">
              {section === "evaluations"
                ? "No reviewed production evaluation report is configured. Synthetic evaluation results do not establish a production baseline."
                : section === "cache"
                  ? "Knowledge retrieval and embedding caches are not configured. No cache metrics are available."
                  : "This data source is not configured."}
            </Banner>
          )}
          {section === "evaluations" && query.data?.available === true && (
            <Banner kind="warning">
              Synthetic contract checks only. Semantic faithfulness and a
              reviewed production baseline remain pending.
            </Banner>
          )}
          {query.data?.available !== false &&
            safeSummary(section, query.data ?? {})}
          {(section === "documents" ||
            section === "retrieval" ||
            section === "traces") &&
            Array.isArray(query.data?.items) &&
            query.data.items.length > 0 &&
            safeRows(section, query.data.items)}
          {Array.isArray(query.data?.items) &&
            query.data.items.length === 0 && (
              <p className="meta">
                No recent {labels[section].toLowerCase()} records.
              </p>
            )}
        </section>
      )}
    </section>
  );
}
