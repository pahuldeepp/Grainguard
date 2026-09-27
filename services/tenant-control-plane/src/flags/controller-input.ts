import { InvalidInputError } from "../domain/errors.js";
import { strictBody } from "../api/http.js";
import { validateFlags, type Flags } from "./store.js";

export function parseFlagUpdate(
  body: unknown,
  ifMatch: string | undefined,
): { flags: Flags; expectedVersion: bigint } {
  const match =
    typeof ifMatch === "string" ? /^"(0|[1-9]\d{0,18})"$/.exec(ifMatch) : null;
  if (!match)
    throw new InvalidInputError(
      'If-Match must be a quoted version; use "0" to create',
    );
  const input = strictBody<{ flags: Flags }>(body, {
    flags: (value) =>
      !!value && typeof value === "object" && !Array.isArray(value),
  });
  return {
    flags: validateFlags(input.flags),
    expectedVersion: BigInt(match[1]!),
  };
}
