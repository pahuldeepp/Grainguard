# Output guardrails v1

## Contract

A generated response has exactly `answer` (nonempty string, at most 12,000
characters in Python / bytes in the Gateway) and `cited_chunk_ids` (unique array
of IDs supplied in the selected authorized context). Unknown fields, bad types,
fabricated IDs and duplicate citations fail closed. The Gateway additionally
rejects duplicate JSON keys, trailing JSON and oversized inner JSON envelopes.
No raw output appears in error messages.

Valid uncited prose is discarded and replaced with a fixed insufficient-evidence
answer. Recognizable injection/tool-execution instructions in output also cause
fixed abstention with no citations. Remaining recognized PII/secrets are redacted;
redaction expansion beyond the output limit causes abstention. Source IDs and
provenance metadata come only from authorized canonical records.

## Final authorization

After generation, HTTP queries reauthenticate the request using the same
credentials and tenant selector. JWT expiry, membership changes, identity changes
and auth dependency errors cannot release the generated answer. The current
role is passed into a fresh canonical hydration statement. Production
(authenticator-backed) requests also require active membership and the current
membership role in the same SQL snapshot as document ACL, deletion and current
version checks, under RLS and explicit tenant filters.

Every passage in the generation context, including uncited passages, is compared with the generation snapshot.
Missing, modified, revoked, deleted or stale sources discard the entire answer;
removing only an invalid citation could retain unauthorized prose. No provider
call occurs after this final check. This database snapshot is the authorization
point: revocations committed afterward cannot retroactively undo a response.
Provider calls never hold database locks. Bootstrap local access bindings and
trusted internal evaluation calls retain their explicit test identity mode.

## CI and limitations

`make verify` runs policy tests, Go JSON/output-provider tests, HTTP
reauthentication tests and real disposable Postgres mutation acceptance through
`postgres_acceptance.py`. Fixtures use model doubles and deliberately mutate
state during generation. Existing cross-tenant/RLS/citation regression gates
remain required.

A valid citation means identity, current access and provenance are verified. It
does not prove each claim is supported by the source. Semantic faithfulness,
citation completeness and general hallucination detection require reviewed
material and calibrated generation evaluations. Static instruction checks and
PII v1 retain their documented limits; names/addresses and arbitrary secret
formats are not comprehensively covered. Tool permissions and audit-log controls
remain separate pending work.
