import { useEffect, useRef, useState } from "react";
import type { AssistantApi, AssistantManagedDocument } from "./assistant-api";

export function AssistantDocuments({
  api,
  sessionId,
  selected,
  busy,
  uploading,
  onDocuments,
  onSelect,
}: {
  api: AssistantApi | null;
  sessionId?: string;
  selected: string;
  busy: boolean;
  uploading?: boolean;
  onDocuments: (documents: AssistantManagedDocument[]) => void;
  onSelect: (value: string) => void;
}) {
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const hydratedSession = useRef<string | undefined>(undefined);
  const refreshDocuments = useRef<(() => void) | null>(null);
  const previousUpload = useRef(uploading);
  const [documents, setDocuments] = useState<AssistantManagedDocument[]>([]);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState("");
  const [confirm, setConfirm] = useState("");
  const callbacks = useRef({ onDocuments, onSelect });
  callbacks.current = { onDocuments, onSelect };
  useEffect(() => {
    if (!api || !sessionId || typeof api.listDocuments !== "function") return;
    hydratedSession.current = undefined;
    setDocuments([]);
    setError("");
    setDeleting("");
    setConfirm("");
    let stopped = false;
    let restored = false;
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(`assistant:selected-pdf:${sessionId}`);
    } catch {
      /* Optional storage must not block the authorized library. */
    }
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      clearTimeout(timer);
      try {
        const items = await api.listDocuments();
        if (stopped) return;
        setDocuments(items);
        callbacks.current.onDocuments(items);
        setError("");

        if (
          !restored &&
          saved &&
          items.some(
            (d) =>
              `${d.document_id}:${d.document_version}` === saved &&
              d.status === "ready",
          )
        )
          callbacks.current.onSelect(saved);
        restored = true;
        hydratedSession.current = sessionId;
        clearTimeout(timer);
        timer = setTimeout(
          load,
          items.some((d) => !["ready", "failed"].includes(d.status))
            ? 5000
            : 30000,
        );
      } catch {
        if (!stopped) {
          setError("Could not load your PDFs. Try again shortly.");
          clearTimeout(timer);
          timer = setTimeout(load, 30000);
        }
      }
    };
    refreshDocuments.current = () => void load();
    void load();
    return () => {
      refreshDocuments.current = null;
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, sessionId]);
  useEffect(() => {
    if (previousUpload.current !== uploading) refreshDocuments.current?.();
    previousUpload.current = uploading;
  }, [uploading]);
  useEffect(() => {
    if (sessionId && hydratedSession.current === sessionId) {
      try {
        sessionStorage.setItem(`assistant:selected-pdf:${sessionId}`, selected);
      } catch {
        /* Selection still works without browser storage. */
      }
    }
  }, [sessionId, selected]);
  async function remove(id: string) {
    if (!api) return;
    const owner = sessionId;
    setDeleting(id);
    setError("");
    try {
      await api.deleteDocument(id);
      if (currentSession.current !== owner) return;
      const next = documents.filter((d) => d.document_id !== id);
      setDocuments(next);
      callbacks.current.onDocuments(next);
      if (selected.startsWith(`${id}:`)) callbacks.current.onSelect("");
      setConfirm("");
    } catch {
      if (currentSession.current === owner)
        setError(
          "Could not delete this PDF. You may need operator permission.",
        );
    } finally {
      if (currentSession.current === owner) setDeleting("");
    }
  }
  if (!api || !sessionId) return null;
  return (
    <details className="assistant-document-library">
      <summary>Uploaded PDFs ({documents.length})</summary>
      {error && <p role="alert">{error}</p>}
      {!documents.length && !error && (
        <p>No uploaded PDFs yet. Use + PDF to attach one.</p>
      )}
      <ul>
        {documents.map((d) => (
          <li key={d.document_id}>
            <button
              type="button"
              disabled={busy || d.status !== "ready"}
              aria-pressed={
                selected === `${d.document_id}:${d.document_version}`
              }
              onClick={() => onSelect(`${d.document_id}:${d.document_version}`)}
            >
              {d.filename}
            </button>
            <span>
              {" "}
              — {d.status} · v{d.document_version}
            </span>{" "}
            {confirm === d.document_id ? (
              <>
                <span>Delete this PDF from your documents?</span>
                <button
                  type="button"
                  disabled={busy || !!deleting}
                  onClick={() => void remove(d.document_id)}
                >
                  Confirm delete PDF
                </button>
                <button type="button" onClick={() => setConfirm("")}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={busy || !!deleting}
                onClick={() => setConfirm(d.document_id)}
              >
                Delete PDF
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
