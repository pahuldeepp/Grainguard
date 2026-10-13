import { useEffect, useRef, useState } from "react";
import type {
  AssistantApi,
  AssistantCitation,
  AssistantSummaryJob as Job,
} from "./assistant-api";
import { AssistantMarkdown } from "./AssistantMarkdown";
export function AssistantSummaryJob({
  api,
  sessionId,
  document,
  busy,
  onCitation,
}: {
  api: AssistantApi | null;
  sessionId?: string;
  document?: { documentId: string; version: number; fileName: string };
  busy: boolean;
  onCitation: (citation: AssistantCitation) => void;
}) {
  const [job, setJob] = useState<Job | null>(null);
  const [jobId, setJobId] = useState("");
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [pollRevision, setPollRevision] = useState(0);
  const generation = useRef(0);
  const requestKey = useRef("");
  const key =
    sessionId && document
      ? `assistant:summary-job:${sessionId}:${document.documentId}:${document.version}`
      : "";
  useEffect(() => {
    generation.current += 1;
    setJob(null);
    setError("");
    setStarting(false);
    let saved = "";
    try {
      if (key) {
        saved = sessionStorage.getItem(key) || "";
        requestKey.current = sessionStorage.getItem(`${key}:pending`) || "";
      } else requestKey.current = "";
    } catch {
      /* storage can be disabled */
    }
    setJobId(saved);
    return () => {
      generation.current += 1;
    };
  }, [key]);
  useEffect(() => {
    if (!api || !jobId || !key) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    async function poll() {
      try {
        const result = await api!.getSummaryJob(jobId);
        if (stopped) return;
        setJob(result);
        setError("");
        failures = 0;
        if (["queued", "running"].includes(result.status))
          timer = setTimeout(poll, 5000);
      } catch {
        if (stopped) return;
        failures += 1;
        setError(
          "Could not check summary progress. The job may still be running.",
        );
        if (failures < 3) timer = setTimeout(poll, 10_000);
      }
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, jobId, key, pollRevision]);
  async function start() {
    if (!api || !document || !key || starting) return;
    const current = generation.current;
    setStarting(true);
    setError("");
    if (!requestKey.current) requestKey.current = crypto.randomUUID();
    try {
      sessionStorage.setItem(`${key}:pending`, requestKey.current);
    } catch {
      /* retry remains stable in memory */
    }
    try {
      const result = await api.startSummaryJob(
        document.documentId,
        document.version,
        "Summarize this PDF completely, section by section, and cite the page numbers.",
        requestKey.current,
      );
      if (generation.current !== current) return;
      setJob(result);
      setJobId(result.job_id);
      requestKey.current = "";
      try {
        sessionStorage.setItem(key, result.job_id);
        sessionStorage.removeItem(`${key}:pending`);
      } catch {
        /* backend remains durable */
      }
    } catch {
      if (generation.current === current)
        setError("Could not start the background summary. Try again shortly.");
    } finally {
      if (generation.current === current) setStarting(false);
    }
  }
  async function cancel() {
    if (!api || !jobId) return;
    const current = generation.current;
    try {
      const result = await api.cancelSummaryJob(jobId);
      if (generation.current === current) {
        setJob(result);
        setPollRevision((v) => v + 1);
      }
    } catch {
      if (generation.current === current)
        setError("Could not cancel the job. Check its status before retrying.");
    }
  }
  if (!api || !sessionId || !document) return null;
  const active = job && ["queued", "running"].includes(job.status);
  return (
    <section
      className="assistant-background-summary"
      aria-label="Background PDF summary"
    >
      <button
        type="button"
        className="btn btn-secondary"
        disabled={busy || starting || !!active}
        onClick={() => void start()}
      >
        {starting ? "Starting summary…" : "Background complete summary"}
      </button>
      <p>
        Processes every page of {document.fileName}. You can continue chatting
        while it runs.
      </p>
      {job && (
        <p role="status">
          Summary: {job.status} · {job.completed_batches} of{" "}
          {job.total_batches || "pending"} sections processed.
        </p>
      )}
      {active && (
        <button type="button" onClick={() => void cancel()}>
          Cancel summary
        </button>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          {jobId && (
            <button type="button" onClick={() => setPollRevision((v) => v + 1)}>
              Check summary status
            </button>
          )}
        </p>
      )}
      {job?.status === "failed" && (
        <p role="alert">
          Summary could not be completed. No partial result is presented.
        </p>
      )}
      {job?.status === "completed" && job.result && (
        <>
          <AssistantMarkdown content={job.result.answer} />
          <ul aria-label="Summary sources">
            {job.result.citations.map((c, i) => (
              <li key={c.chunk_id ?? i}>
                <button type="button" onClick={() => onCitation(c)}>
                  {document.fileName} · p.{c.page_start}
                  {c.page_end && c.page_end !== c.page_start
                    ? `–${c.page_end}`
                    : ""}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
