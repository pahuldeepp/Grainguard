import { AssistantMarkdown } from "./AssistantMarkdown";
import { useEffect, useState, useRef } from "react";
import type { AccessTokenProvider } from "./provisioning";
import {
  AdvisorApi,
  AdvisorRequestError,
  advisorExecutionAttemptLimit,
  type AdvisorProposal,
} from "./advisor-api";
import type { AssistantCitation } from "./assistant-api";

function agentFailureMessage(status: number): string {
  if (status === 401)
    return "Your session expired. Sign in again to use the agent.";
  if (status === 403) return "You do not have access to this request.";
  if (status === 503)
    return "Agent services are temporarily unavailable. Please try again later.";
  return "The agent could not complete this request.";
}

function actionFailureMessage(
  reason: unknown,
  mutationStarted: boolean,
  notice: string,
): string {
  if (reason instanceof AdvisorRequestError) return reason.message;
  if (mutationStarted)
    return "The action outcome could not be confirmed. Refresh its status before retrying.";
  return (
    notice || "Action status could not be confirmed. Refresh before retrying."
  );
}

function agentRunLabel(busy: boolean, cooldownSeconds: number): string {
  if (busy) return "Working…";
  if (cooldownSeconds > 0) return `Try again in ${cooldownSeconds}s`;
  return "Run agent";
}

function executionStatusLabel(proposal: AdvisorProposal): string {
  if (proposal.execution_status === "succeeded")
    return "Completed and confirmed";
  if (
    proposal.execution_status === "failed" ||
    Number(proposal.execution_attempts) >= advisorExecutionAttemptLimit
  )
    return "Stopped; no further retries allowed";
  if (proposal.execution_status === "running")
    return "In progress; refresh to check the outcome";
  if (proposal.execution_status === "retryable")
    return "Completion not confirmed; a manual retry is available";
  return "Completion not confirmed";
}

export function AssistantAgent({
  getAccessToken,
  onCitation,
  selectedDocument,
}: {
  getAccessToken: AccessTokenProvider;
  onCitation?: (citation: AssistantCitation) => void;
  selectedDocument?: { documentId: string; version: number };
}) {
  const generation = useRef(0);
  const busyRef = useRef(false);
  const refreshSequence = useRef(0);
  const controller = useRef(new AbortController());
  const proposalRecords = useRef<AdvisorProposal[]>([]);
  const retryDeadlines = useRef<Record<string, number>>({});
  const [unconfirmed, setUnconfirmed] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [citations, setCitations] = useState<AssistantCitation[]>([]);
  const [proposals, setProposals] = useState<AdvisorProposal[]>([]);
  const [approvalError, setApprovalError] = useState("");
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const cooldownSeconds = Math.max(
    0,
    Math.ceil((cooldownUntil - clock) / 1000),
  );
  useEffect(() => {
    if (!cooldownUntil && proposals.length === 0) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setClock(now);
      if (cooldownUntil && now >= cooldownUntil) setCooldownUntil(0);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil, proposals.length]);
  const remember = (proposal: AdvisorProposal) => {
    const old = proposalRecords.current.find(
      (p) => p.proposal_id === proposal.proposal_id,
    );
    if (
      proposal.execution_status === "running" &&
      (old?.execution_status !== "running" ||
        old.execution_attempts !== proposal.execution_attempts)
    ) {
      retryDeadlines.current[proposal.proposal_id] = Date.now() + 30000;
    }
    proposalRecords.current = [
      ...proposalRecords.current.filter(
        (p) => p.proposal_id !== proposal.proposal_id,
      ),
      proposal,
    ];
    setProposals(proposalRecords.current);
    setUnconfirmed((prev) => ({ ...prev, [proposal.proposal_id]: false }));
  };
  const refresh = async () => {
    if (busyRef.current) return;
    const current = generation.current;
    const sequence = ++refreshSequence.current;
    setRefreshing(true);
    try {
      const items = await new AdvisorApi(getAccessToken).list(
        50,
        controller.current.signal,
      );
      if (
        current !== generation.current ||
        sequence !== refreshSequence.current
      )
        return;
      const retained = proposalRecords.current
        .filter(
          (p) => !items.some((item) => item.proposal_id === p.proposal_id),
        )
        .slice(-10);
      // Unresolved lists omit successful actions. Preserve checked receipts;
      // absence alone never proves that a timed-out mutation succeeded.
      for (const item of items) remember(item);
      proposalRecords.current = [...retained, ...items];
      setProposals(proposalRecords.current);
      setApprovalError("");
    } catch {
      if (current === generation.current)
        setApprovalError(
          "Approvals could not be loaded. Refresh to check action status.",
        );
    } finally {
      if (
        current === generation.current &&
        sequence === refreshSequence.current
      )
        setRefreshing(false);
    }
  };
  useEffect(() => {
    generation.current++;
    controller.current = new AbortController();
    busyRef.current = false;
    proposalRecords.current = [];
    retryDeadlines.current = {};
    setProposals([]);
    setUnconfirmed({});
    setBusy(false);
    setRefreshing(false);
    setQuestion("");
    setResult("");
    setCitations([]);
    setError("");
    setApprovalError("");
    setCooldownUntil(0);
    setClock(Date.now());
    void refresh();
    return () => {
      generation.current++;
      controller.current.abort();
    };
  }, [getAccessToken]);
  const refreshProposal = async (proposal: AdvisorProposal) => {
    if (busyRef.current) return;
    busyRef.current = true;
    refreshSequence.current++;
    setRefreshing(false);
    setBusy(true);
    const current = generation.current;
    try {
      const updated = await new AdvisorApi(getAccessToken).get(
        proposal.proposal_id,
        controller.current.signal,
      );
      if (current === generation.current) {
        remember(updated);
        setError("");
      }
    } catch (reason) {
      if (current === generation.current) {
        setUnconfirmed((prev) => ({ ...prev, [proposal.proposal_id]: true }));
        setError(
          reason instanceof AdvisorRequestError
            ? reason.message
            : "Action status could not be confirmed. Refresh before retrying.",
        );
      }
    } finally {
      if (current === generation.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const run = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const current = generation.current;
    setBusy(true);
    setError("");
    setResult("");
    setCitations([]);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Sign in to use the agent.");
      const response = await fetch("/v1/assistant/agent", {
        method: "POST",
        cache: "no-store",
        signal: AbortSignal.timeout(125000),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question,
          ...(selectedDocument
            ? {
                selected_document: {
                  document_id: selectedDocument.documentId,
                  document_version: selectedDocument.version,
                },
              }
            : {}),
        }),
      });
      if (response.status === 429) {
        if (current !== generation.current) {
          await response.body?.cancel();
          return;
        }
        const delay = Number(response.headers.get("Retry-After"));
        const seconds =
          Number.isFinite(delay) && delay > 0
            ? Math.min(3600, Math.ceil(delay))
            : 30;
        const now = Date.now();
        setClock(now);
        setCooldownUntil(now + seconds * 1000);
        await response.body?.cancel();
        throw new Error("Requests are temporarily rate limited.");
      }
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as {
          code?: string;
        } | null;
        const messages: Record<string, string> = {
          device_not_found:
            "That device was not found in your account. Check its name or ID.",
          device_lookup_ambiguous:
            "More than one device has that name. Use the device ID.",
          device_lookup_unavailable:
            "Device lookup is temporarily unavailable. Please try again later.",
          device_read_unavailable:
            "Live device readings are temporarily unavailable. Please try again later.",
        };
        throw new Error(
          (failure?.code && messages[failure.code]) ||
            agentFailureMessage(response.status),
        );
      }
      const value = (await response.json()) as {
        tool?: string;
        content?: { type: string; text?: string }[];
        citations?: AssistantCitation[];
      };
      if (current !== generation.current) return;
      setResult(
        (value.content ?? [])
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("\n"),
      );
      setCitations(
        (Array.isArray(value.citations) ? value.citations : []).filter(
          (citation) =>
            citation !== null &&
            typeof citation === "object" &&
            typeof citation.document_id === "string" &&
            /^[0-9a-f-]{36}$/i.test(citation.document_id) &&
            Number.isSafeInteger(citation.document_version) &&
            Number(citation.document_version) > 0 &&
            Number.isSafeInteger(citation.page_start) &&
            Number(citation.page_start) > 0,
        ),
      );
      busyRef.current = false;
      await refresh();
    } catch (e) {
      if (current === generation.current)
        setError(e instanceof Error ? e.message : "Agent unavailable.");
    } finally {
      if (current === generation.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const mutate = async (
    proposal: AdvisorProposal,
    decision?: "approved" | "rejected",
  ) => {
    if (busyRef.current) return;
    busyRef.current = true;
    refreshSequence.current++;
    setRefreshing(false);
    const current = generation.current;
    const signal = controller.current.signal;
    const api = new AdvisorApi(getAccessToken);
    setBusy(true);
    setError("");
    let mutationStarted = false;
    let statusChecked = false;
    let notice = "";
    try {
      const latest = await api.get(proposal.proposal_id, signal);
      if (current !== generation.current) return;
      remember(latest);
      statusChecked = true;
      if (
        latest.action_hash !== proposal.action_hash ||
        latest.version !== proposal.version ||
        latest.status !== proposal.status
      ) {
        notice =
          "This proposal changed. Review its current action and status before continuing.";
        throw new Error(notice);
      }
      if (decision) {
        if (
          latest.status !== "pending" ||
          !Number.isFinite(Date.parse(latest.expires_at)) ||
          Date.parse(latest.expires_at) <= Date.now()
        ) {
          notice = "This proposal is no longer awaiting an unexpired decision.";
          throw new Error(notice);
        }
        mutationStarted = true;
        await api.decide(latest, decision, signal);
      } else {
        if (latest.execution_status === "succeeded") return;
        if (
          latest.status !== "approved" ||
          !Number.isSafeInteger(latest.execution_attempts) ||
          Number(latest.execution_attempts) >= advisorExecutionAttemptLimit ||
          !["pending", "retryable", "running"].includes(
            latest.execution_status ?? "",
          ) ||
          Date.now() < (retryDeadlines.current[latest.proposal_id] ?? 0)
        ) {
          notice =
            "This action cannot be retried yet. Check its current execution status.";
          throw new Error(notice);
        }
        mutationStarted = true;
        await api.execute(latest, signal);
      }
      const updated = await api.get(proposal.proposal_id, signal);
      if (current !== generation.current) return;
      remember(updated);
      if (updated.execution_status === "running")
        retryDeadlines.current[updated.proposal_id] = Date.now() + 30000;
      setCitations([]);
    } catch (reason) {
      if (current !== generation.current) return;
      if (!statusChecked)
        setUnconfirmed((prev) => ({ ...prev, [proposal.proposal_id]: true }));
      if (reason instanceof AdvisorRequestError && reason.status === 429) {
        retryDeadlines.current[proposal.proposal_id] =
          Date.now() + reason.retryAfter * 1000;
      }
      if (mutationStarted) {
        // Reconcile a lost HTTP response with a read. Never automatically repeat
        // a human decision or owner mutation, even after a transport timeout.
        try {
          const updated = await api.get(proposal.proposal_id, signal);
          if (current !== generation.current) return;
          remember(updated);
          if (
            updated.execution_status === "succeeded" ||
            updated.status === "rejected"
          ) {
            setError("");
            return;
          }
        } catch {
          if (current !== generation.current) return;
          setUnconfirmed((prev) => ({ ...prev, [proposal.proposal_id]: true }));
        }
      }
      setError(actionFailureMessage(reason, mutationStarted, notice));
    } finally {
      if (current === generation.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <details className="assistant-agent">
      <summary>Agent tools and approvals</summary>
      <p>
        Ask the agent to search documents, read alert or device risk facts, or
        propose an alert acknowledgement. Changes require your approval.
      </p>
      <label className="sr-only" htmlFor="assistant-agent-question">
        Agent request
      </label>
      <textarea
        id="assistant-agent-question"
        placeholder="What temperature checks do my uploaded PDFs recommend? Cite the pages."
        value={question}
        maxLength={2000}
        onChange={(e) => setQuestion(e.target.value)}
        disabled={busy}
      />
      <button
        type="button"
        disabled={busy || cooldownSeconds > 0 || question.trim().length < 4}
        onClick={() => void run()}
      >
        {agentRunLabel(busy, cooldownSeconds)}
      </button>
      {error && (
        <p role="alert">
          {error === "Requests are temporarily rate limited." &&
          cooldownSeconds === 0
            ? "Cooldown finished. You can run the agent again."
            : error}
        </p>
      )}
      {result && <AssistantMarkdown content={result} />}
      {citations.length > 0 && onCitation && (
        <ul aria-label="Agent sources">
          {citations.map((citation, index) => (
            <li key={`${citation.chunk_id ?? citation.document_id}:${index}`}>
              <button type="button" onClick={() => onCitation(citation)}>
                Document {citation.document_id?.slice(0, 8)} · v
                {citation.document_version} · p.{citation.page_start}
              </button>
            </li>
          ))}
        </ul>
      )}
      <h3>Approvals and execution status</h3>
      {approvalError && <p role="alert">{approvalError}</p>}
      <button
        type="button"
        disabled={busy || refreshing}
        onClick={() => void refresh()}
      >
        Refresh approvals
      </button>
      {proposals.length === 0 && !approvalError ? (
        <p>No actions awaiting review.</p>
      ) : (
        proposals.map((p) => (
          <article key={p.proposal_id}>
            <h4>Proposed {p.action.action}</h4>
            <dl>
              <dt>Target</dt>
              <dd>{p.action.target}</dd>
              <dt>Action</dt>
              <dd>
                <pre>{JSON.stringify(p.action, null, 2)}</pre>
              </dd>
              <dt>Action hash</dt>
              <dd style={{ overflowWrap: "anywhere" }}>{p.action_hash}</dd>
              <dt>Version</dt>
              <dd>{p.version}</dd>
              <dt>Approval deadline</dt>
              <dd>{p.expires_at}</dd>
              <dt>Approval status</dt>
              <dd>{p.status}</dd>
              {p.status === "approved" && (
                <>
                  <dt>Execution status</dt>
                  <dd>
                    {clock < (retryDeadlines.current[p.proposal_id] ?? 0) && (
                      <p>
                        Retry available in{" "}
                        {Math.ceil(
                          (retryDeadlines.current[p.proposal_id] - clock) /
                            1000,
                        )}
                        s. Refresh can still check the current status.
                      </p>
                    )}
                    {executionStatusLabel(p)}
                  </dd>
                  <dt>Execution attempts</dt>
                  <dd>
                    {p.execution_attempts ?? "Unknown"} of{" "}
                    {advisorExecutionAttemptLimit}
                  </dd>
                </>
              )}
              {unconfirmed[p.proposal_id] && (
                <>
                  <dt>Status confirmation</dt>
                  <dd>
                    Current status unavailable. Refresh before another action.
                  </dd>
                </>
              )}
            </dl>
            <button
              type="button"
              disabled={busy || refreshing}
              onClick={() => void refreshProposal(p)}
            >
              Refresh action status
            </button>
            {p.status === "pending" && (
              <>
                <button
                  disabled={
                    busy ||
                    refreshing ||
                    Boolean(unconfirmed[p.proposal_id]) ||
                    !Number.isFinite(Date.parse(p.expires_at)) ||
                    Date.parse(p.expires_at) <= clock
                  }
                  type="button"
                  onClick={() => void mutate(p, "approved")}
                >
                  Approve this exact action
                </button>
                <button
                  disabled={
                    busy ||
                    refreshing ||
                    Boolean(unconfirmed[p.proposal_id]) ||
                    Date.parse(p.expires_at) <= clock
                  }
                  type="button"
                  onClick={() => void mutate(p, "rejected")}
                >
                  Reject
                </button>
              </>
            )}
            {p.status === "approved" &&
              ["pending", "retryable", "running"].includes(
                p.execution_status ?? "",
              ) && (
                <button
                  disabled={
                    busy ||
                    refreshing ||
                    Boolean(unconfirmed[p.proposal_id]) ||
                    !Number.isSafeInteger(p.execution_attempts) ||
                    Number(p.execution_attempts) >=
                      advisorExecutionAttemptLimit ||
                    clock < (retryDeadlines.current[p.proposal_id] ?? 0)
                  }
                  type="button"
                  onClick={() => void mutate(p)}
                >
                  Retry approved action
                </button>
              )}
            {p.execution_status === "succeeded" && p.execution_receipt && (
              <details>
                <summary>Execution confirmation</summary>
                <pre>{JSON.stringify(p.execution_receipt, null, 2)}</pre>
              </details>
            )}
          </article>
        ))
      )}
    </details>
  );
}
