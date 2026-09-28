import type { ReactNode } from "react";
import type { Marker, MarkerKind } from "./severity";

// Small inline icon set. Glyphs are decorative (aria-hidden): the word next to
// them carries the meaning, so severity is never colour or shape alone.
const glyphs: Record<MarkerKind | "check" | "arrow-left", ReactNode> = {
  critical: (
    <>
      <path
        d="M8.2 2.5h7.6l5.7 5.7v7.6l-5.7 5.7H8.2l-5.7-5.7V8.2z"
        fill="currentColor"
      />
      <path
        d="M12 7.5v5.5m0 3v.01"
        stroke="var(--ink)"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />
    </>
  ),
  high: (
    <>
      <path d="M12 3 22 20.5H2z" fill="currentColor" strokeLinejoin="round" />
      <path
        d="M12 9.5v5m0 2.6v.01"
        stroke="var(--ink)"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />
    </>
  ),
  warning: (
    <>
      <path
        d="M12 3.6 21 19.6H3z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M12 9.5v4.5m0 2.4v.01"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />
    </>
  ),
  notice: (
    <>
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M12 11v5.5m0-8.6v.01"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />
    </>
  ),
  ok: (
    <>
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="m7.8 12.4 2.9 2.9 5.6-6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </>
  ),
  offline: (
    <>
      <path
        d="M6.5 18.5a4.3 4.3 0 0 1-.6-8.55A6 6 0 0 1 17.4 8.9a4.8 4.8 0 0 1 .1 9.6z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="m4 4 16 16"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />
    </>
  ),
  open: (
    <>
      <rect
        x="4"
        y="4"
        width="16"
        height="16"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
    </>
  ),
  check: (
    <path
      d="m5 12.5 4.5 4.5L19 7.5"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  ),
  "arrow-left": (
    <path
      d="M19 12H5m6-6-6 6 6 6"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  ),
};

export function Glyph({
  name,
}: Readonly<{ name: MarkerKind | "check" | "arrow-left" }>) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className="glyph"
    >
      {glyphs[name]}
    </svg>
  );
}

export function NavIcon({
  name,
}: Readonly<{ name: "overview" | "provisioning" | "devices" | "alerts" }>) {
  const paths: Record<typeof name, string> = {
    overview: "M4 13h6V4H4zm10 7h6V11h-6zM4 20h6v-4H4zm10-12h6V4h-6z",
    provisioning: "M12 5v14M5 12h14",
    devices: "M6 4h12v16H6zm3 4h6m-6 4h6m-6 4h3",
    alerts:
      "M12 4a5 5 0 0 0-5 5v3.5L5 16h14l-2-3.5V9a5 5 0 0 0-5-5zm-2 14a2 2 0 0 0 4 0",
  };
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className="nav-icon"
    >
      <path
        d={paths[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function StatusMarker({ marker }: Readonly<{ marker: Marker }>) {
  return (
    <span className={`sev sev-${marker.kind}`}>
      <Glyph name={marker.kind} />
      <span className="sev-word">{marker.word}</span>
    </span>
  );
}

export function Banner({
  kind,
  children,
}: Readonly<{ kind: MarkerKind; children: ReactNode }>) {
  return (
    <div className={`banner sev-${kind}`}>
      <Glyph name={kind} />
      <p>{children}</p>
    </div>
  );
}

export function PageHeader({
  id,
  title,
  children,
}: Readonly<{ id: string; title: string; children?: ReactNode }>) {
  return (
    <header className="page-head">
      <h1 id={id}>{title}</h1>
      {children && <p className="lede">{children}</p>}
    </header>
  );
}

// Loading: a status line plus skeleton rows, never a spinner-only screen.
export function Loading({
  label,
  rows = 3,
}: Readonly<{ label: string; rows?: number }>) {
  return (
    <>
      <output className="loading-label">{label}</output>
      <ul className="rows skeleton-rows" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <li key={index}>
            <span className="skeleton skeleton-title" />
            <span className="skeleton skeleton-meta" />
          </li>
        ))}
      </ul>
    </>
  );
}

export function EmptyState({
  title,
  children,
}: Readonly<{ title: string; children?: ReactNode }>) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <p className="meta">{children}</p>}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: Readonly<{ message: string; onRetry?: () => void }>) {
  return (
    <div className="error-state">
      <p role="alert" className="sev sev-critical error-text">
        <Glyph name="critical" />
        <span>{message}</span>
      </p>
      {onRetry && (
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function FieldError({
  id,
  children,
}: Readonly<{ id: string; children: ReactNode }>) {
  return (
    <p id={id} role="alert" className="field-error">
      <Glyph name="critical" />
      <span>{children}</span>
    </p>
  );
}
