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

function summaryFields(
  section: RagOperationsSection,
  data: Record<string, unknown>,
): unknown[][] {
  const items = Array.isArray(data.items) ? data.items : [];
  switch (section) {
    case "cache":
      return [
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
      ];
    case "evaluations":
      return [
        ["Dataset", data.dataset_version],
        ["Cases", data.case_count],
        ["Passed controls", data.passed_count],
        ["Gate passed", data.passed],
        ["Report SHA-256", data.report_sha256],
        ["Report updated", data.window],
        ["Source", data.source],
      ];
    case "overview":
      return [
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
      ];
    default:
      return [
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
  }
}

function safeSummary(
  section: RagOperationsSection,
  data: Record<string, unknown>,
) {
  const fields = summaryFields(section, data);
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

function rowCellValue(row: Record<string, unknown>, key: string): string {
  let value = row[key];
  if (key === "citation_count")
    value = Array.isArray(row.citations) ? row.citations.length : 0;
  if (key === "at" && typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value * 1000);
    value = Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return safeText(value);
}

function rowIdentity(
  section: RagOperationsSection,
  row: Record<string, unknown>,
  cells: string[],
): string {
  if (
    section === "documents" &&
    typeof row.document_id === "string" &&
    row.document_id &&
    (typeof row.version === "string" || typeof row.version === "number")
  ) {
    return JSON.stringify(["document", row.document_id, row.version]);
  }
  if (
    section !== "documents" &&
    typeof row.request_id === "string" &&
    row.request_id
  ) {
    return JSON.stringify(["request", row.request_id]);
  }
  // Sparse diagnostic records have no owner identity. Use only displayed fields,
  // never prompts, credentials, or arbitrary response payloads.
  return JSON.stringify(["displayed", ...cells]);
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
  const occurrences = new Map<string, number>();
  const rows = items.slice(0, 100).map((item) => {
    const row = record(item);
    const cells = columns.map(([, key]) => rowCellValue(row, key));
    const identity = rowIdentity(section, row, cells);
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    return { key: JSON.stringify([identity, occurrence]), cells };
  });
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
          {rows.map((row) => (
            <tr key={row.key}>
              {columns.map(([label], column) => (
                <td key={label}>{row.cells[column]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function unavailableMessage(section: RagOperationsSection): string {
  if (section === "evaluations")
    return "No reviewed production evaluation report is configured. Synthetic evaluation results do not establish a production baseline.";
  if (section === "cache")
    return "Knowledge retrieval and embedding caches are not configured. No cache metrics are available.";
  return "This data source is not configured.";
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

  let content;
  if (!api || !sessionId) {
    content = <EmptyState title="Sign in to view RAG operations." />;
  } else if (query.isPending) {
    content = <Loading label="Loading RAG operations…" rows={3} />;
  } else if (query.isError) {
    content = (
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
    );
  } else {
    content = (
      <section className="section" aria-label={`${labels[section]} metrics`}>
        {query.data?.available === false && (
          <Banner kind="warning">{unavailableMessage(section)}</Banner>
        )}
        {section === "evaluations" && query.data?.available === true && (
          <Banner kind="warning">
            Synthetic contract checks only. Semantic faithfulness and a reviewed
            production baseline remain pending.
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
        {Array.isArray(query.data?.items) && query.data.items.length === 0 && (
          <p className="meta">
            No recent {labels[section].toLowerCase()} records.
          </p>
        )}
      </section>
    );
  }

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
      {content}
    </section>
  );
}
