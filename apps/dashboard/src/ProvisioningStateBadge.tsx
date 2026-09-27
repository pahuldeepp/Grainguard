import { Glyph } from "./ui";
import type { MarkerKind } from "./severity";

const kinds: Record<string, MarkerKind> = {
  active: "ok",
  compensated: "notice",
  compensating: "warning",
  repair_required: "critical",
  reserving: "notice",
  configuring: "notice",
  activating: "notice",
};

// Same glyph + word as every other status: colour is never the only signal.
export function ProvisioningStateBadge({ state }: Readonly<{ state: string }>) {
  const kind = kinds[state] ?? "notice";
  return (
    <span className={`sev sev-${kind}`}>
      <Glyph name={kind} />
      <span className="sev-word state-word">{state.replaceAll("_", " ")}</span>
    </span>
  );
}
