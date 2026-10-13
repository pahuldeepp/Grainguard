import { useEffect, useRef, useState } from "react";
import type {
  PDFDocumentProxy,
  PDFDocumentLoadingTask,
  RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/** Render only page graphics/text: no PDF scripts, interactive forms or link annotations. */
export function SourcePdfPreview({
  blob,
  filename,
  initialPage,
}: {
  blob: Blob;
  filename: string;
  initialPage: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(initialPage);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  useEffect(() => {
    let alive = true;
    let task: PDFDocumentLoadingTask | undefined;
    setPdf(null);
    setPage(initialPage);
    setError("");
    setLoading(true);
    void (async () => {
      try {
        const library = await import("pdfjs-dist");
        const data = new Uint8Array(await blob.arrayBuffer());
        if (!alive) return;
        library.GlobalWorkerOptions.workerSrc = workerUrl;
        task = library.getDocument({
          data,
          enableXfa: false,
          stopAtErrors: true,
          maxImageSize: 4_000_000,
        });
        const document = await task.promise;
        if (!alive) return;
        if (initialPage < 1 || initialPage > document.numPages)
          throw new Error("invalid cited page");
        setPdf(document);
      } catch {
        if (alive) {
          setError(
            "Couldn’t render this PDF page. You can download the PDF below.",
          );
          setLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
      void task?.destroy().catch(() => {});
    };
  }, [blob, initialPage]);
  useEffect(() => {
    if (!pdf) return;
    let alive = true;
    let rendering: RenderTask | undefined;
    setLoading(true);
    setError("");
    setText("");
    void (async () => {
      try {
        const source = await pdf.getPage(page);
        if (!alive || !canvas.current) return;
        const base = source.getViewport({ scale: 1 });
        const width = Math.min(
          1000,
          canvas.current.parentElement?.clientWidth || 900,
        );
        const scale = Math.min(
          width / base.width,
          1.5,
          4096 / base.width,
          4096 / base.height,
          Math.sqrt(4_000_000 / (base.width * base.height)),
        );
        const viewport = source.getViewport({ scale });
        const target = canvas.current;
        const context = target.getContext("2d");
        if (!context) throw new Error("canvas unavailable");
        target.width = Math.ceil(viewport.width);
        target.height = Math.ceil(viewport.height);
        rendering = source.render({
          canvas: target,
          canvasContext: context,
          viewport,
          annotationMode: 0,
        });
        await rendering.promise;
        const content = await source.getTextContent();
        if (alive) {
          setText(
            content.items
              .slice(0, 2000)
              .map((item) => ("str" in item ? item.str : ""))
              .join(" ")
              .slice(0, 24000),
          );
          setLoading(false);
        }
      } catch {
        if (alive) {
          setError(
            "Couldn’t render this PDF page. You can download the PDF below.",
          );
          setLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
      rendering?.cancel();
    };
  }, [pdf, page]);
  return (
    <section className="assistant-pdf-page" aria-label="Rendered PDF page">
      <nav aria-label="PDF pages">
        <button
          type="button"
          disabled={!pdf || page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          Previous page
        </button>{" "}
        <span>
          Page {page}
          {pdf ? ` of ${pdf.numPages}` : ""}
        </span>{" "}
        <button
          type="button"
          disabled={!pdf || page >= pdf.numPages}
          onClick={() => setPage((p) => p + 1)}
        >
          Next page
        </button>
      </nav>
      {loading ? <p role="status">Rendering page {page}…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <canvas
        ref={canvas}
        aria-label={`${filename}, page ${page}`}
        data-rendered={!loading && !error && pdf ? "true" : "false"}
      />
      {text ? (
        <details>
          <summary>Accessible page text</summary>
          <p>{text}</p>
        </details>
      ) : null}
    </section>
  );
}
