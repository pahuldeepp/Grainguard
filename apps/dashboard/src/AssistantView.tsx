import { AssistantAgent } from "./AssistantAgent";
import type { AccessTokenProvider } from "./provisioning";
import { AssistantSummaryJob } from "./AssistantSummaryJob";
import { AssistantDocuments } from "./AssistantDocuments";
import { AssistantMarkdown } from "./AssistantMarkdown";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { SourcePdfPreview } from "./SourcePdfPreview";
import { EmptyState, PageHeader } from "./ui";
import { AssistantUploadOutcomeUnknownError } from "./assistant-api";
import type {
  AssistantApi,
  AssistantDocumentScope,
  AssistantCitation,
  AssistantConversation,
  AssistantConversationSummary,
  AssistantMessage,
  AssistantSuggestion,
} from "./assistant-api";

const DRAFT_ID = "local-draft";
const MAX_STATUS_ERRORS = 3;

interface PendingDocumentStatus {
  documentId: string;
  version: number;
  fileName: string;
  outcome: "accepted" | "unknown";
}

function citationLabel(citation: AssistantCitation, filename?: string) {
  const document =
    filename ??
    (citation.document_id
      ? `Document ${citation.document_id.slice(0, 8)}`
      : "Source document");
  const version = citation.document_version
    ? ` · v${citation.document_version}`
    : "";
  const page = citation.page_start
    ? ` · p.${citation.page_start}${citation.page_end && citation.page_end !== citation.page_start ? `–${citation.page_end}` : ""}`
    : "";
  return `${document}${version}${page}`;
}

function isTransientStatusFailure(reason: unknown) {
  if (reason instanceof TypeError) return true;
  if (
    reason instanceof DOMException &&
    (reason.name === "TimeoutError" || reason.name === "NetworkError")
  )
    return true;
  if (reason && typeof reason === "object" && "status" in reason) {
    const status = (reason as { status?: unknown }).status;
    if (
      status === 404 ||
      status === 408 ||
      status === 429 ||
      (typeof status === "number" && status >= 500 && status <= 599)
    )
      return true;
  }
  return (
    reason instanceof Error &&
    [
      "rate_limited",
      "provider_rate_limited",
      "gateway_rate_limited",
      "rate_limit_unavailable",
      "service_unavailable",
      "assistant_unavailable",
      "assistant_history_unavailable",
      "assistant_suggestions_unavailable",
      "assistant_upload_unavailable",
      "knowledge_unavailable",
      "not_found",
    ].includes(reason.message)
  );
}

type AssistantOperation = "send" | "history" | "open" | "delete" | "upload";

function errorText(reason: unknown, operation: AssistantOperation = "send") {
  const message =
    reason instanceof Error ? reason.message : "assistant_unavailable";
  const transientFailure =
    operation === "send"
      ? "Couldn’t confirm whether your message was saved. Refresh this chat before retrying."
      : operation === "history"
        ? "Saved chats are temporarily unavailable. Please retry shortly."
        : operation === "open"
          ? "Couldn’t open this chat. Refresh your chat list and try again."
          : operation === "delete"
            ? "Couldn’t confirm whether this chat was deleted. Refresh your chat list to check."
            : "Couldn’t confirm the PDF upload status. Check the document list before uploading again.";
  if (message === "document_scope_unavailable")
    return "The selected PDF version is unavailable or you no longer have access. Choose an available PDF and retry.";
  if (message === "summary_document_required")
    return "Choose one PDF before requesting a complete summary.";
  if (message === "document_summary_source_changed")
    return "This PDF version changed. Choose its current version before summarizing.";
  if (message === "document_summary_incomplete")
    return "A complete summary could not be verified. No partial summary was saved; try again or ask about a smaller section.";
  if (message === "document_summary_too_large")
    return "This PDF is too large for a complete summary. Ask about a smaller section.";
  if (message === "document_summary_unsafe")
    return "This PDF cannot be summarized because it did not pass the document safety checks.";
  if (message === "not_found") {
    if (operation === "open" || operation === "send" || operation === "delete")
      return "This chat was deleted or is no longer available to your account. Refresh your chat list.";
    if (operation === "upload")
      return "The requested document was not found. Choose the PDF again and retry.";
    return "The requested Assistant resource is no longer available. Refresh and try again.";
  }
  if (message === "access_denied")
    return "Your account does not have access to ask questions here.";
  if (message === "insufficient_role")
    return operation === "upload"
      ? "PDF uploads are available to farm operators and admins. Ask an administrator for access."
      : "Your account does not have permission to use this Assistant feature. Ask an administrator for access.";
  if (message === "invalid_pdf")
    return "Choose a non-empty PDF file smaller than 25 MB.";
  if (message === "pdf_too_large")
    return "This PDF is larger than the 25 MB upload limit.";
  if (message === "rate_limited") {
    const retryAfter = (reason as Error & { retryAfterSeconds?: number })
      .retryAfterSeconds;
    const retryText =
      typeof retryAfter === "number" && retryAfter > 0
        ? `Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`
        : "Wait a moment and try again.";
    if (operation !== "send")
      return `${operation === "upload" ? "PDF upload" : "This Assistant action"} is temporarily rate limited. ${retryText}`;
    if (typeof retryAfter === "number" && retryAfter > 0)
      return `You’re sending questions too quickly. ${retryText}`;
    return "You’re sending questions too quickly. Wait a moment and try again.";
  }
  if (
    message === "provider_rate_limited" ||
    message === "gateway_rate_limited"
  ) {
    const retryAfter = (reason as Error & { retryAfterSeconds?: number })
      .retryAfterSeconds;
    const retryText =
      typeof retryAfter === "number" && retryAfter > 0
        ? `Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`
        : "Wait a moment and try again.";
    if (operation !== "send")
      return `The AI service is temporarily busy. ${retryText}`;
    if (typeof retryAfter === "number" && retryAfter > 0)
      return `The AI service is handling too many requests right now. ${retryText} Refresh this chat before retrying.`;
    return "The AI service is handling too many requests right now. Wait a moment and refresh this chat before retrying.";
  }
  if (message === "rate_limit_unavailable")
    return operation === "send"
      ? "The Assistant cannot check its request limits right now. Couldn’t confirm whether your message was saved; refresh this chat before retrying."
      : `The Assistant is temporarily unavailable because its request protection service is not responding. ${transientFailure}`;
  if (message === "assistant_not_configured")
    return operation === "send"
      ? "Saved Assistant conversations are not connected in this environment yet. Your message was not sent."
      : "Saved Assistant conversations are not connected in this environment yet.";
  if (message === "sign_in_required")
    return "Your sign-in has expired. Sign in again to continue.";
  if (
    message === "service_unavailable" ||
    message === "knowledge_unavailable" ||
    message === "knowledge_ops_unavailable" ||
    message === "assistant_history_unavailable" ||
    message === "assistant_suggestions_unavailable" ||
    message === "assistant_upload_unavailable"
  )
    return `GreenGuard Assistant is temporarily unavailable. ${transientFailure}`;
  return operation === "send"
    ? "GreenGuard Assistant is not connected right now. Couldn’t confirm whether your message was saved. Refresh this chat before retrying."
    : operation === "history"
      ? "Couldn’t load saved chats right now. Please retry shortly."
      : operation === "open"
        ? "Couldn’t open this chat right now. Please retry shortly."
        : operation === "delete"
          ? "Couldn’t confirm whether this chat was deleted. Refresh your chat list to check."
          : operation === "upload"
            ? "Couldn’t confirm the PDF upload status. Check the document list before uploading again."
            : "GreenGuard Assistant is temporarily unavailable. Please retry shortly.";
}

export function AssistantView({
  api,
  sessionId,
  getAccessToken,
}: Readonly<{
  api: AssistantApi | null;
  sessionId?: string;
  getAccessToken?: AccessTokenProvider;
}>) {
  const [conversations, setConversations] = useState<
    AssistantConversationSummary[]
  >([]);
  const [activeId, setActiveId] = useState<string>(DRAFT_ID);
  const [activeConversation, setActiveConversation] =
    useState<AssistantConversation | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [opening, setOpening] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [error, setError] = useState("");
  const [retryAfterSeconds, setRetryAfterSeconds] = useState(0);
  const [suggestions, setSuggestions] = useState<AssistantSuggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [selectedSuggestion, setSelectedSuggestion] =
    useState<AssistantSuggestion | null>(null);
  const [uploading, setUploading] = useState(false);
  const [submittingPdf, setSubmittingPdf] = useState(false);
  const [documentNotice, setDocumentNotice] = useState("");
  const [documentLibraryLoaded, setDocumentLibraryLoaded] = useState(false);
  const [readyDocuments, setReadyDocuments] = useState<
    Array<{ documentId: string; version: number; fileName: string }>
  >([]);
  const [selectedDocument, setSelectedDocument] = useState("");
  const [summaryMode, setSummaryMode] = useState(false);
  const [pendingDocumentStatus, setPendingDocumentStatus] =
    useState<PendingDocumentStatus | null>(null);
  const uploadGeneration = useRef(0);
  const uploadCancellation = useRef(new AbortController());
  const fileInput = useRef<HTMLInputElement>(null);
  const [sourceNames, setSourceNames] = useState<Record<string, string>>({});
  const [sourcePreview, setSourcePreview] = useState<{
    url: string;
    blob: Blob;
    filename: string;
    page: number;
  } | null>(null);
  const [sourceError, setSourceError] = useState("");
  const [sourceLoading, setSourceLoading] = useState(false);
  const loadedSourceNames = useRef(new Set<string>());
  const sourceDialog = useRef<HTMLDialogElement>(null);
  const sourceGeneration = useRef(0);
  const sourceUrl = useRef<string | null>(null);
  function closeSource() {
    if (
      sourceDialog.current?.open &&
      typeof sourceDialog.current.close === "function"
    )
      sourceDialog.current.close();
    sourceGeneration.current += 1;
    if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current);
    sourceUrl.current = null;
    setSourcePreview(null);
    setSourceLoading(false);
  }
  useEffect(() => {
    uploadGeneration.current += 1;
    uploadCancellation.current.abort();
    uploadCancellation.current = new AbortController();
    setPendingDocumentStatus(null);
    setDocumentNotice("");
    setUploading(false);
    setSubmittingPdf(false);
    setDocumentLibraryLoaded(false);
    setReadyDocuments([]);
    setSelectedDocument("");
    loadedSourceNames.current.clear();
    setSourceNames({});
    setSourceError("");
    closeSource();
    return () => {
      uploadGeneration.current += 1;
      uploadCancellation.current.abort();
      sourceGeneration.current += 1;
      if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current);
      sourceUrl.current = null;
    };
  }, [api, sessionId]);
  useEffect(() => {
    const dialog = sourceDialog.current;
    if (sourcePreview && dialog && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
  }, [sourcePreview]);
  async function openSource(citation: AssistantCitation) {
    if (
      !api ||
      !sessionId ||
      !citation.document_id ||
      !citation.document_version ||
      !citation.page_start
    )
      return;
    closeSource();
    const generation = sourceGeneration.current;
    setSourceLoading(true);
    setSourceError("");
    try {
      const source = await api.getDocumentSource(
        citation.document_id,
        citation.document_version,
      );
      if (generation !== sourceGeneration.current) return;
      const url = URL.createObjectURL(source.blob);
      sourceUrl.current = url;
      setSourcePreview({
        url,
        blob: source.blob,
        filename: source.filename,
        page: citation.page_start,
      });
      setSourceNames((items) => ({
        ...items,
        [`${citation.document_id}:${citation.document_version}`]:
          source.filename,
      }));
    } catch {
      if (generation === sourceGeneration.current)
        setSourceError(
          "This source PDF is unavailable or you no longer have access. Refresh and try again.",
        );
    } finally {
      if (generation === sourceGeneration.current) setSourceLoading(false);
    }
  }
  const isDraft = activeId === DRAFT_ID;
  const active =
    activeConversation?.id === activeId ? activeConversation : null;

  useEffect(() => {
    if (retryAfterSeconds <= 0) return;
    const timer = window.setTimeout(
      () => setRetryAfterSeconds((remaining) => Math.max(0, remaining - 1)),
      1000,
    );
    return () => window.clearTimeout(timer);
  }, [retryAfterSeconds]);

  useEffect(() => {
    let alive = true;
    setReadyDocuments([]);
    setSelectedDocument("");
    setSummaryMode(false);
    setActiveId(DRAFT_ID);
    setActiveConversation(null);
    if (!api || !sessionId) {
      setConversations([]);
      setSuggestions([]);
      return () => {
        alive = false;
      };
    }
    setHistoryLoading(true);
    setSuggestionsLoading(true);
    void api
      .listConversations()
      .then((items) => {
        if (alive) {
          setConversations(items);
          setHistoryError("");
        }
      })
      .catch((reason) => {
        if (alive) setHistoryError(errorText(reason, "history"));
      })
      .finally(() => {
        if (alive) setHistoryLoading(false);
      });
    void api
      .getSuggestions()
      .then((items) => {
        if (alive) setSuggestions(items);
      })
      .catch(() => {
        if (alive) setSuggestions([]);
      })
      .finally(() => {
        if (alive) setSuggestionsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [api, sessionId]);

  function startChat() {
    setActiveId(DRAFT_ID);
    setActiveConversation(null);
    setSummaryMode(false);
    setDraft("");
    setSelectedSuggestion(null);
    setError("");
    setOpening(false);
    if (!pendingDocumentStatus) setDocumentNotice("");
  }

  async function openConversation(summary: AssistantConversationSummary) {
    if (!api) return;
    setActiveId(summary.id);
    setActiveConversation(null);
    setDraft("");
    setSelectedSuggestion(null);
    setError("");
    setOpening(true);
    try {
      const detail = await api.getConversation(summary.id);
      setActiveConversation(detail);
      const previousScope = [...detail.messages]
        .reverse()
        .find(
          (message) =>
            message.mode === "document_summary" &&
            message.document_id &&
            message.document_version,
        );
      setSelectedDocument(
        previousScope
          ? `${previousScope.document_id}:${previousScope.document_version}`
          : "",
      );
      setSummaryMode(Boolean(previousScope));
    } catch (reason) {
      setError(errorText(reason, "open"));
    } finally {
      setOpening(false);
    }
  }

  async function refreshConversations(fallback?: AssistantConversationSummary) {
    if (!api) return;
    try {
      const items = await api.listConversations();
      setConversations(
        fallback && !items.some((item) => item.id === fallback.id)
          ? [fallback, ...items]
          : items,
      );
    } catch {
      /* Keep the saved response in view; history can be refreshed on the next page load. */
    }
  }

  async function deleteConversation(summary: AssistantConversationSummary) {
    if (!api) return;
    setDeletingId(summary.id);
    setError("");
    try {
      await api.deleteConversation(summary.id);
      setConversations((items) =>
        items.filter((item) => item.id !== summary.id),
      );
      if (activeId === summary.id) {
        setActiveId(DRAFT_ID);
        setActiveConversation(null);
        setDraft("");
        setSelectedSuggestion(null);
      }
      setDeleteConfirmId(null);
    } catch (reason) {
      setError(errorText(reason, "delete"));
    } finally {
      setDeletingId(null);
    }
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const question = draft.trim();
    if (
      !question ||
      sending ||
      opening ||
      submittingPdf ||
      retryAfterSeconds > 0 ||
      !api ||
      !sessionId
    )
      return;
    setError("");
    setSending(true);
    try {
      const scopedDocument = documentChoices.find(
        (document) =>
          `${document.documentId}:${document.version}` === selectedDocument,
      );
      if (summaryMode && !scopedDocument)
        throw new Error("summary_document_required");
      if (selectedDocument && !scopedDocument) {
        setSelectedDocument("");
        throw new Error("document_scope_unavailable");
      }
      let conversationId = isDraft ? null : activeId;
      let createdConversation: AssistantConversationSummary | undefined;
      if (!conversationId) {
        const created = await api.createConversation(question);
        createdConversation = created;
        conversationId = created.id;
        setActiveId(created.id);
        setConversations((items) => [
          created,
          ...items.filter((item) => item.id !== created.id),
        ]);
      }
      const scope: AssistantDocumentScope | undefined = scopedDocument
        ? {
            mode: summaryMode ? "document_summary" : "question",
            document_id: scopedDocument.documentId,
            document_version: scopedDocument.version,
          }
        : undefined;
      const result = scope
        ? await api.sendMessage(conversationId, question, scope)
        : await api.sendMessage(conversationId, question);
      const base =
        activeConversation?.id === conversationId
          ? activeConversation
          : (conversations.find((item) => item.id === conversationId) ??
            createdConversation);
      const next: AssistantConversation = {
        id: conversationId,
        title:
          base?.title && base.title !== "New chat"
            ? base.title
            : result.user_message.content
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 56) || "New chat",
        ...(base?.updated_at ? { updated_at: base.updated_at } : {}),
        messages: [
          ...(activeConversation?.id === conversationId
            ? activeConversation.messages
            : []),
          result.user_message,
          result.assistant_message,
        ],
      };
      setActiveId(conversationId);
      setActiveConversation(next);
      setConversations((items) => [
        {
          id: next.id,
          title: next.title,
          ...("updated_at" in next && next.updated_at
            ? { updated_at: next.updated_at }
            : {}),
        },
        ...items.filter((item) => item.id !== next.id),
      ]);
      setDraft("");
      setSummaryMode(false);
      if (selectedSuggestion && selectedSuggestion.label === question) {
        void api
          .recordSuggestionUsed(selectedSuggestion.id)
          .catch(() => undefined);
      }
      setSelectedSuggestion(null);
      void refreshConversations({
        id: next.id,
        title: next.title,
        ...(next.updated_at ? { updated_at: next.updated_at } : {}),
      });
    } catch (reason) {
      const retryAfter =
        reason instanceof Error
          ? (reason as Error & { retryAfterSeconds?: number }).retryAfterSeconds
          : undefined;
      setRetryAfterSeconds(
        reason instanceof Error &&
          (reason.message === "rate_limited" ||
            reason.message === "provider_rate_limited" ||
            reason.message === "gateway_rate_limited") &&
          retryAfter
          ? retryAfter
          : 0,
      );
      setError(errorText(reason, "send"));
    } finally {
      setSending(false);
    }
  }

  async function checkDocumentStatus(
    document: PendingDocumentStatus,
    generation = uploadGeneration.current,
  ) {
    if (!api || uploading || generation !== uploadGeneration.current) return;
    setUploading(true);
    setError("");
    setDocumentNotice(
      document.outcome === "accepted"
        ? `${document.fileName} was accepted and is being indexed in your farm’s shared knowledge library…`
        : `We couldn’t confirm whether ${document.fileName} was accepted. Checking its upload status now…`,
    );
    let consecutiveErrors = 0;
    try {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (generation !== uploadGeneration.current) return;
        try {
          const status = await api.getDocumentStatus(
            document.documentId,
            document.version,
            15_000,
            uploadCancellation.current.signal,
          );
          if (generation !== uploadGeneration.current) return;
          consecutiveErrors = 0;
          if (status.status === "ready") {
            setPendingDocumentStatus(null);
            setReadyDocuments((documents) => [
              ...documents.filter(
                (item) =>
                  item.documentId !== document.documentId ||
                  item.version !== document.version,
              ),
              document,
            ]);
            setSelectedDocument(`${document.documentId}:${document.version}`);
            setDocumentNotice(
              `${document.fileName} is ready in your farm’s shared knowledge library. You can ask the Assistant about it now.`,
            );
            return;
          }
          if (status.status === "failed") {
            setPendingDocumentStatus(null);
            setDocumentNotice(
              `${document.fileName} was accepted, but indexing failed. Contact an administrator to review this document’s processing status.`,
            );
            return;
          }
        } catch (reason) {
          if (generation !== uploadGeneration.current) return;
          if (!isTransientStatusFailure(reason)) {
            setPendingDocumentStatus(document);
            setDocumentNotice(
              document.outcome === "accepted"
                ? `${document.fileName} was accepted, but its indexing status could not be checked. Resolve the issue shown below, then retry the status check. Do not upload it again.`
                : `We couldn’t confirm whether ${document.fileName} was accepted. Resolve the issue shown below, then retry the status check. Do not upload it again.`,
            );
            setError(errorText(reason, "upload"));
            return;
          }
          consecutiveErrors += 1;
          if (consecutiveErrors >= MAX_STATUS_ERRORS) {
            setPendingDocumentStatus(document);
            setDocumentNotice(
              document.outcome === "accepted"
                ? `${document.fileName} was accepted. Its latest indexing status is temporarily unavailable; it may still be processing. Retry the status check below. Do not upload it again.`
                : `We couldn’t confirm whether ${document.fileName} was accepted. Retry the status check below; do not upload it again.`,
            );
            return;
          }
          const backoffMs = Math.min(8000, 500 * 2 ** (consecutiveErrors - 1));
          await new Promise((resolve) => window.setTimeout(resolve, backoffMs));
          continue;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
      }
      if (generation !== uploadGeneration.current) return;
      setPendingDocumentStatus(document);
      setDocumentNotice(
        document.outcome === "accepted"
          ? `${document.fileName} was accepted and is still processing. Its status check timed out; retry the status check below. Do not upload it again.`
          : `We couldn’t confirm whether ${document.fileName} was accepted. Retry the status check below; do not upload it again.`,
      );
    } finally {
      if (generation === uploadGeneration.current) setUploading(false);
    }
  }

  async function attachPdf(file?: File) {
    if (!file || !api || !sessionId || uploading || pendingDocumentStatus)
      return;
    const generation = uploadGeneration.current;
    setError("");
    setDocumentNotice(
      `Uploading ${file.name} to your farm’s shared knowledge library…`,
    );
    setUploading(true);
    setSubmittingPdf(true);
    try {
      const uploaded = await api.uploadPdf(
        file,
        uploadCancellation.current.signal,
      );
      if (generation !== uploadGeneration.current) return;
      const pending = {
        documentId: uploaded.document_id,
        version: uploaded.document_version,
        fileName: file.name,
        outcome: "accepted" as const,
      };
      setPendingDocumentStatus(pending);
      setDocumentNotice(
        `${file.name} was accepted and is being indexed in your farm’s shared knowledge library…`,
      );
      setUploading(false);
      setSubmittingPdf(false);
      await checkDocumentStatus(pending, generation);
    } catch (reason) {
      if (generation !== uploadGeneration.current) return;
      if (reason instanceof AssistantUploadOutcomeUnknownError) {
        const pending: PendingDocumentStatus = {
          documentId: reason.documentId,
          version: reason.documentVersion,
          fileName: file.name,
          outcome: "unknown",
        };
        setPendingDocumentStatus(pending);
        setDocumentNotice(
          `We couldn’t confirm whether ${file.name} was accepted. Checking the same upload ID now; do not upload it again.`,
        );
        setUploading(false);
        setSubmittingPdf(false);
        await checkDocumentStatus(pending, generation);
        return;
      }
      setDocumentNotice("");
      setError(errorText(reason, "upload"));
    } finally {
      if (generation === uploadGeneration.current) {
        setUploading(false);
        setSubmittingPdf(false);
        if (fileInput.current) fileInput.current.value = "";
      }
    }
  }

  function retryDocumentStatus() {
    if (pendingDocumentStatus) void checkDocumentStatus(pendingDocumentStatus);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  const messages: AssistantMessage[] = active?.messages ?? [];
  const sourceReferences = JSON.stringify([
    ...new Map(
      messages
        .flatMap((message) => message.citations)
        .filter((c) => c.document_id && c.document_version)
        .map((c) => [
          `${c.document_id}:${c.document_version}`,
          [c.document_id, c.document_version],
        ]),
    ).values(),
  ]);
  useEffect(() => {
    let alive = true;
    if (api && sessionId && typeof api.getDocumentSourceInfo === "function") {
      const refs = JSON.parse(sourceReferences) as Array<[string, number]>;
      void (async () => {
        for (const [id, version] of refs) {
          if (!alive) break;
          if (loadedSourceNames.current.has(`${id}:${version}`)) continue;
          try {
            const info = await api.getDocumentSourceInfo(id, version);
            if (alive) {
              loadedSourceNames.current.add(`${id}:${version}`);
              setSourceNames((items) => ({
                ...items,
                [`${id}:${version}`]: info.filename,
              }));
            }
          } catch {
            /* Deleted/revoked sources keep their safe fallback label. */
          }
        }
      })();
    }
    return () => {
      alive = false;
    };
  }, [api, sessionId, sourceReferences]);
  const documentChoices = [...readyDocuments];
  for (const message of documentLibraryLoaded ? [] : messages) {
    const references = [
      ...message.citations,
      ...(message.document_id && message.document_version
        ? [
            {
              document_id: message.document_id,
              document_version: message.document_version,
            },
          ]
        : []),
    ];
    for (const reference of references) {
      if (
        reference.document_id &&
        reference.document_version &&
        !documentChoices.some(
          (item) =>
            item.documentId === reference.document_id &&
            item.version === reference.document_version,
        )
      )
        documentChoices.push({
          documentId: reference.document_id,
          version: reference.document_version,
          fileName: `Document ${reference.document_id.slice(0, 8)} · v${reference.document_version}`,
        });
    }
  }
  return (
    <div className="assistant-layout">
      {sourceLoading ? <p role="status">Opening source PDF…</p> : null}
      {sourceError ? <p role="alert">{sourceError}</p> : null}
      {sourcePreview ? (
        <dialog
          ref={sourceDialog}
          aria-label="Source PDF preview"
          className="assistant-source-preview"
          onCancel={(event) => {
            event.preventDefault();
            closeSource();
          }}
          onClose={(event) => {
            if (event.currentTarget.isConnected && !event.currentTarget.open)
              closeSource();
          }}
        >
          <header>
            <strong>
              {sourcePreview.filename} · p.{sourcePreview.page}
            </strong>
            <button type="button" onClick={closeSource}>
              Close PDF
            </button>
          </header>
          <SourcePdfPreview
            blob={sourcePreview.blob}
            filename={sourcePreview.filename}
            initialPage={sourcePreview.page}
          />
          <a
            href={`${sourcePreview.url}#page=${sourcePreview.page}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open PDF in a new tab
          </a>{" "}
          <a href={sourcePreview.url} download={sourcePreview.filename}>
            Download PDF
          </a>
        </dialog>
      ) : null}
      <aside className="assistant-sidebar" aria-label="Chat history">
        <div className="assistant-sidebar-head">
          <h2>GreenGuard Assistant</h2>
          <button
            className="btn btn-primary assistant-new-chat"
            type="button"
            disabled={opening || sending}
            onClick={startChat}
          >
            <span aria-hidden="true">＋</span> New chat
          </button>
        </div>
        <p className="assistant-history-label">Recent</p>
        {historyLoading ? (
          <p className="assistant-history-empty" role="status">
            Loading saved chats…
          </p>
        ) : null}
        {conversations.length ? (
          <ul className="assistant-history">
            {conversations.map((chat) => (
              <li key={chat.id}>
                <button
                  type="button"
                  className={chat.id === activeId ? "active" : undefined}
                  aria-current={chat.id === activeId ? "page" : undefined}
                  onClick={() => void openConversation(chat)}
                  disabled={opening || sending || deletingId !== null}
                >
                  {chat.title}
                </button>
                {deleteConfirmId === chat.id ? (
                  <div
                    className="assistant-delete-confirm"
                    role="group"
                    aria-label={`Delete ${chat.title}`}
                  >
                    <span>Delete this chat?</span>
                    <button
                      type="button"
                      onClick={() => void deleteConversation(chat)}
                      disabled={deletingId !== null}
                    >
                      {deletingId === chat.id ? "Deleting…" : "Confirm delete"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteConfirmId(null)}
                      disabled={deletingId !== null}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="assistant-history-delete"
                    aria-label={`Delete ${chat.title}`}
                    onClick={() => {
                      setDeleteConfirmId(chat.id);
                      setError("");
                    }}
                    disabled={opening || sending || deletingId !== null}
                  >
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : !historyLoading ? (
          <p className="assistant-history-empty">
            {historyError || "Your saved chats will appear here."}
          </p>
        ) : null}
        <p className="assistant-sidebar-foot">
          Your conversations are saved to your account.
        </p>
      </aside>

      <main className="assistant-main" aria-labelledby="assistant-title">
        <header className="assistant-topline">
          <PageHeader id="assistant-title" title="GreenGuard Assistant">
            Ask questions about documents you’re authorized to access.
          </PageHeader>
          <span className="assistant-audience">For farm teams</span>
        </header>

        <section
          className="assistant-conversation"
          aria-live="polite"
          aria-label="Conversation"
        >
          {opening ? (
            <p className="assistant-thinking" role="status">
              Loading conversation…
            </p>
          ) : null}
          {messages.length ? (
            messages.map((message) => (
              <article
                className={`assistant-message assistant-message-${message.role}`}
                key={message.id}
              >
                <p className="assistant-message-role">
                  {message.role === "user" ? "You" : "GreenGuard Assistant"}
                </p>
                {message.role === "assistant" ? (
                  <AssistantMarkdown content={message.content} />
                ) : (
                  <p className="assistant-message-text">{message.content}</p>
                )}
                {message.citations?.length ? (
                  <ul className="assistant-citations" aria-label="Sources">
                    {message.citations.map((citation, index) => (
                      <li
                        key={
                          citation.chunk_id ??
                          `${citation.document_id ?? "source"}-${index}`
                        }
                      >
                        {citation.document_id &&
                        citation.document_version &&
                        citation.page_start ? (
                          <button
                            type="button"
                            className="assistant-citation-link"
                            disabled={sourceLoading || !api || !sessionId}
                            onClick={() => void openSource(citation)}
                          >
                            {citationLabel(
                              citation,
                              sourceNames[
                                `${citation.document_id}:${citation.document_version}`
                              ] ??
                                readyDocuments.find(
                                  (d) =>
                                    d.documentId === citation.document_id &&
                                    d.version === citation.document_version,
                                )?.fileName,
                            )}
                          </button>
                        ) : (
                          citationLabel(citation)
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </article>
            ))
          ) : !opening ? (
            <div className="assistant-welcome">
              <p className="assistant-welcome-mark" aria-hidden="true">
                ✳
              </p>
              <h2>
                {isDraft
                  ? "How can I help with your operation?"
                  : "What would you like to ask?"}
              </h2>
              <p>
                Ask about your farm documents, grain handling, storage
                conditions, or operating procedures.
              </p>
              {!api || !sessionId ? (
                <EmptyState title="Sign in to ask GreenGuard Assistant." />
              ) : (
                <div className="assistant-suggestions">
                  {suggestionsLoading ? (
                    <p className="assistant-suggestions-status" role="status">
                      Loading suggestions…
                    </p>
                  ) : suggestions.length ? (
                    suggestions.map((suggestion) => (
                      <button
                        key={suggestion.id}
                        type="button"
                        onClick={() => {
                          setDraft(suggestion.label);
                          setSelectedSuggestion(suggestion);
                          setError("");
                        }}
                      >
                        {suggestion.label}
                      </button>
                    ))
                  ) : (
                    <p className="assistant-suggestions-status">
                      No suggestions available right now. You can still ask a
                      question.
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : null}
          {sending && (
            <p className="assistant-thinking" role="status">
              {summaryMode
                ? "Reading every indexed text page of the selected PDF and summarizing its sections…"
                : "Searching your authorized documents…"}
            </p>
          )}
          {error && (
            <p className="assistant-error" role="alert">
              {error}
            </p>
          )}
        </section>

        <AssistantDocuments
          uploading={uploading}
          api={api}
          sessionId={sessionId}
          selected={selectedDocument}
          busy={sending || opening || uploading}
          onSelect={(value) => {
            setSelectedDocument(value);
            setSummaryMode(false);
          }}
          onDocuments={(documents) => {
            setDocumentLibraryLoaded(true);
            setReadyDocuments(
              documents
                .filter((d) => d.status === "ready")
                .map((d) => ({
                  documentId: d.document_id,
                  version: d.document_version,
                  fileName: d.filename,
                })),
            );
          }}
        />
        {documentChoices.length ? (
          <div className="assistant-document-summary">
            <label htmlFor="assistant-summary-document">
              PDF for this question
            </label>{" "}
            <select
              id="assistant-summary-document"
              value={selectedDocument}
              disabled={sending || opening}
              onChange={(event) => {
                setSelectedDocument(event.target.value);
                setSummaryMode(false);
              }}
            >
              <option value="">All authorized documents</option>
              {documentChoices.map((document) => (
                <option
                  key={`${document.documentId}:${document.version}`}
                  value={`${document.documentId}:${document.version}`}
                >
                  {document.fileName}
                </option>
              ))}
            </select>{" "}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!selectedDocument || sending || opening}
              onClick={() => {
                setSummaryMode(true);
                setSelectedSuggestion(null);
                setDraft(
                  "Summarize this PDF completely, section by section, and cite the page numbers.",
                );
                setError("");
              }}
            >
              Summarize selected PDF
            </button>
            {selectedDocument && !summaryMode ? (
              <p role="status">
                Answers and citations use only the selected PDF and version.
              </p>
            ) : null}
            {summaryMode ? (
              <p role="status">
                Complete summary uses only the selected PDF and its version.{" "}
                <button
                  type="button"
                  onClick={() => setSummaryMode(false)}
                  disabled={sending}
                >
                  Ask a question about this PDF
                </button>
              </p>
            ) : null}
          </div>
        ) : null}
        {getAccessToken && sessionId ? (
          <AssistantAgent
            key={`agent:${sessionId}`}
            getAccessToken={getAccessToken}
            onCitation={(citation) => void openSource(citation)}
            selectedDocument={documentChoices.find(
              (d) => `${d.documentId}:${d.version}` === selectedDocument,
            )}
          />
        ) : null}
        <AssistantSummaryJob
          key={`summary:${sessionId}:${selectedDocument}`}
          api={api}
          sessionId={sessionId}
          document={documentChoices.find(
            (d) => `${d.documentId}:${d.version}` === selectedDocument,
          )}
          busy={sending || opening}
          onCitation={(citation) => void openSource(citation)}
        />
        <form
          className="assistant-composer"
          onSubmit={(event) => void send(event)}
        >
          <input
            ref={fileInput}
            className="sr-only"
            type="file"
            accept="application/pdf,.pdf"
            aria-label="Choose a PDF to upload"
            onChange={(event) => void attachPdf(event.currentTarget.files?.[0])}
            disabled={
              !api ||
              !sessionId ||
              uploading ||
              sending ||
              opening ||
              pendingDocumentStatus !== null
            }
          />
          <button
            className="btn btn-secondary assistant-attach"
            type="button"
            aria-label="Attach PDF"
            onClick={() => fileInput.current?.click()}
            disabled={
              !api ||
              !sessionId ||
              uploading ||
              sending ||
              opening ||
              pendingDocumentStatus !== null
            }
            title="Upload a PDF to your farm’s shared knowledge library (operators and admins)"
          >
            {uploading ? "Processing…" : "＋ PDF"}
          </button>
          <label className="sr-only" htmlFor="assistant-question">
            Message GreenGuard Assistant
          </label>
          <textarea
            id="assistant-question"
            value={draft}
            maxLength={2000}
            rows={1}
            placeholder="Ask a question about your farm documents…"
            onChange={(event) => {
              setDraft(event.target.value);
              if (event.target.value !== selectedSuggestion?.label)
                setSelectedSuggestion(null);
            }}
            onKeyDown={onComposerKeyDown}
            disabled={!api || !sessionId || sending || opening}
          />
          <button
            className="btn btn-primary assistant-send"
            type="submit"
            disabled={
              !api ||
              !sessionId ||
              !draft.trim() ||
              sending ||
              opening ||
              submittingPdf ||
              retryAfterSeconds > 0
            }
          >
            {sending
              ? "Sending…"
              : retryAfterSeconds > 0
                ? `Wait ${retryAfterSeconds}s`
                : "Send"}
          </button>
          {documentNotice ? (
            <p className="assistant-upload-status" role="status">
              {documentNotice}
            </p>
          ) : null}
          {submittingPdf ? (
            <p className="assistant-composer-note" role="status">
              Your message draft stays here while the PDF upload is being
              submitted.
            </p>
          ) : null}
          {pendingDocumentStatus ? (
            <button
              className="btn btn-secondary assistant-status-retry"
              type="button"
              onClick={retryDocumentStatus}
              disabled={uploading}
            >
              {uploading ? "Checking status…" : "Retry status check"}
            </button>
          ) : null}
          <p className="assistant-composer-note">
            Answers use authorized documents and include source citations when
            available.
          </p>
        </form>
      </main>
    </div>
  );
}
