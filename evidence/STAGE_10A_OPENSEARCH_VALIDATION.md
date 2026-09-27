# Stage 10a OpenSearch profile validation (2026-09-25)

The alternate search profile is isolated from the existing Elasticsearch service and pinned to the OpenSearch 3.8.0 image. It exposes only loopback port 29200 and disables the security plugin for disposable local testing; this profile is not a production security configuration.

## Acceptance run

`make search-opensearch-test` passed:

- OpenSearch container started and passed its health check.
- All **20** search-indexer unit/contract tests passed.
- The existing live acceptance suite passed against `http://127.0.0.1:29200`: index creation, duplicate replay/idempotency, tenant-filtered search, exact identity/version/content manifest comparison, rejected mismatched manifest, acknowledged write fencing, and atomic alias switch.
- `make check-plan`, Compose configuration validation and `git diff --check` passed.

The implementation reuses the existing search-indexer contract rather than creating a second search service. Stage 10a demonstrates the local OpenSearch adapter profile; it does not qualify a managed OpenSearch deployment, authentication/TLS policy, multi-node behavior or production capacity.

## Run it

- `make search-opensearch-up`
- `make search-opensearch-test`
- `make search-opensearch-down`

The official OpenSearch docs currently identify 3.8.0 as a released Docker image and document the acknowledged write-block operation used by the shared alias-promotion flow: [OpenSearch Docker installation](https://docs.opensearch.org/latest/install-and-configure/install-opensearch/docker/), [OpenSearch Blocks API](https://docs.opensearch.org/latest/api-reference/index-apis/blocks/).
