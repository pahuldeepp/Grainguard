# AI egress redaction — policy v1

The Knowledge Service redacts query embeddings, every PDF chunk embedding,
authorized hydrated context before reranking/generation, generated answers and
citation heading text. The Go Model Gateway independently redacts embedding,
reranking and generation requests and generated answer prose. Authorization and
prompt-injection checks run first. Tenant, document/version, chunk identifiers,
pages and citation allowlists remain unchanged.

Original PDFs and canonical Postgres content remain private, authorized source
records with their original hashes. This policy protects AI egress and public RAG
responses; it does not sanitize source downloads or erase originals. Dense
embeddings use redacted content; FTS searches private canonical content under
existing RLS/ACL. Existing vectors need reindexing to remove previously indexed
private values. Reindex/version retirement remains an operational requirement.

Supported patterns: email addresses; North American dashed/spaced/dotted phone
numbers; recognizable sk-/pcsk_ provider keys, AWS access key IDs, JWTs, Bearer
tokens, labelled password/API-key/access-token/client-secret assignments and
PEM private keys. Unicode compatibility forms and invisible format characters
are normalized before scanning. Placeholders expose only a category, never a
matched value, digest or reversible token. Processing is deterministic and uses
existing dependencies. Python inputs are bounded; Gateway request bounds apply.

Private key markers anywhere in a passage collection replace the entire
collection to prevent a key body split across chunks or embedding batches from
escaping. This intentionally sacrifices useful context for that document.

Limitations: arbitrary names/addresses, arbitrary unlabelled secrets, every
international contact/identity format, encoded/encrypted values, and general
cross-chunk fragmented credentials are not comprehensively detected. No claim
of complete DLP compliance or production security proof is made. Expand policy
with reviewed domain/privacy cases before production. No matched source values
are emitted in diagnostics. Original-storage retention/deletion is a separate
lifecycle control.

Tests: `make verify` includes Python policy tests, Gateway provider-spy tests,
and real PostgreSQL PDF ingestion/query acceptance with model doubles, original
preservation, heading redaction, citation identity and cross-tenant denial.
Live Claude is not needed for this deterministic boundary test.
