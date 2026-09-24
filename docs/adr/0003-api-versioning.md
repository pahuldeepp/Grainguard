# ADR-0003: header-based API versioning with deprecation and sunset

Status: accepted, 2026-09-23 (Stage 02b).

Clients select the contract revision with the `API-Version` header. The `/v1` path prefix names the resource namespace and stays stable; breaking changes to request or response shapes are introduced as a new header version, not a new URL tree, so routes, caches and links do not change.

- Each version has an optional `deprecatedAt` and `sunsetAt`, a `successor` and a `documentationUrl`. A deprecated version keeps working and announces itself with `Deprecation` (RFC 9745) and `Sunset` (RFC 8594) headers plus `Link` relations. After `sunsetAt` it answers `410 Gone`, and it does so before authentication so retired clients see the reason without a token.
- A missing header means the default version. An unknown or malformed value is a `400` listing the supported versions; the raw value is never written to a response header; it appears only in the 400 body, truncated to 64 characters and JSON-encoded.
- The policy is data (`API_VERSION_POLICY`), validated at startup. A wrong policy stops the service instead of silently serving the wrong contract.
- Events are versioned separately: each event type has a strict, immutable `vN` JSON Schema, and a change needs a new schema version with consumers upgraded first (see `docs/FIRST_VERTICAL_SLICE.md` section 3).
- Row versions are a third mechanism and are unrelated: `ETag` and `If-Match` carry a device's `binding_version` for optimistic concurrency ([ADR-0002](0002-concurrency-control.md)).

Consequences: retiring a version is a configuration change with a published date, not a deployment. Only header versions that exist in the registry can be requested, so adding a version means adding it to the policy and to the tests.
