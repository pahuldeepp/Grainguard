# Go tenant placement and pools

`SHARD_REGISTRY_FILE` enables placement routing. The file must be a regular file with mode `0400` or `0440`, contain exactly `s1` through `s4`, and match the service, database and runtime role. Kubernetes Secret volumes use `0440` with the pod's `fsGroup` so the non-root application user can read credentials; the volume is mounted only into the application container. Group write/execute and all world permissions are rejected. Example shape (substitute private credentials):

```json
{"formatVersion":1,"service":"projection-builder","database":"greenguard_read","shards":{"s1":{"incarnation":"11111111-1111-4111-8111-111111111111","primaryUrl":"postgres://projection_app:REDACTED@read-s1.internal/greenguard_read?sslmode=verify-full","replicaUrls":[]},"s2":{"incarnation":"22222222-2222-4222-8222-222222222222","primaryUrl":"postgres://projection_app:REDACTED@read-s2.internal/greenguard_read?sslmode=verify-full","replicaUrls":[]},"s3":{"incarnation":"33333333-3333-4333-8333-333333333333","primaryUrl":"postgres://projection_app:REDACTED@read-s3.internal/greenguard_read?sslmode=verify-full","replicaUrls":[]},"s4":{"incarnation":"44444444-4444-4444-8444-444444444444","primaryUrl":"postgres://projection_app:REDACTED@read-s4.internal/greenguard_read?sslmode=verify-full","replicaUrls":[]}}}
```

Connection URL authority/path supplies host, user and database. Query overrides (`host`, `user`, `dbname`, `service`, `options`, etc.), repeated query keys and duplicate host/effective-port/database endpoints are rejected. Only TLS configuration, connect timeout and application name query parameters are accepted. Remote endpoints require verified TLS with no plaintext fallback; loopback development may use `sslmode=disable`.

Set `CONTROL_PLANE_URL` and `CONTROL_LOOKUP_TOKEN`. HTTPS is accepted; loopback HTTP is for isolated development. HTTP internal DNS/private addresses additionally require `CONTROL_PLANE_MESH_MTLS=true`, declaring that the deployment's mesh authenticates/encrypts that hop. This flag does not install a mesh. Credential verification and membership lookups preserve the same declared transport boundary.

`ShardedDB.WithTenantSchema` resolves the already authenticated/validated tenant, verifies the authority response, selects the configured primary, then runs `WithTenantPlacement`. Route epoch is exact decimal text, cache life is at most one second and never exceeds authority expiry. There is no stale or secondary-shard fallback. The durable local ownership row is matched and locked in the transaction; trigger fences repeat admission on mutations. Rejected ownership clears the cached route. Search path is set in that same transaction. Direct `ShardedDB.BeginTx` fails to prevent unscoped writes.

Each primary pool is lazy and capped at five connections: at most twenty connections per service process across four primaries. Replicas are validated registry entries but these writer paths never use them. `Close` rejects subsequent pool acquisition and closes every opened pool. `ForEachPrimary` visits all four sequentially and fails on any required unavailable shard.

## Infrastructure

Customer ownership is separate from the reserved infrastructure tenant `00000000-0000-4000-8000-000000000001`. An explicit `InfrastructureDB(shard)` pins the private registry incarnation and calls `admit_shard_infrastructure`; only an already active durable bootstrap row admits it. The helper never invents or seeds identity. Writers lock that row, while read-only ID/count selectors use a compatible snapshot check.

The owner migrations install this narrow function and grant only their existing runtime roles. Operators must bootstrap the reserved identity on every primary. Projection's customer snapshot importer preserves it separately; other owner snapshot imports currently need the reserved row explicitly in the complete snapshot to avoid fencing it. Customers discovered on an old shard still resolve the current authority before reading operational data or mutating it.

Run services with a registry to use these paths. Without one, the prior fixed URL mode remains for existing local fixtures. Missing or malformed registry/authority/ownership never falls back to that URL.
