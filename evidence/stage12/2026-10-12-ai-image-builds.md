# AI image build readiness — local amd64 proof

All seven AI Dockerfiles in the committed platform inventory were built from
`ee71f43` application sources using Docker Desktop BuildKit with
`docker build --platform linux/amd64`. Infrastructure-only edits in this
checkout do not alter these Dockerfiles or application sources. Each build
returned exit code 0; image inspection confirms amd64 and non-root user 10001.
Build cache was reused. This is not a clean, network-independent build proof.

| Service | Dockerfile | Local image config ID |
| --- | --- | --- |
| knowledge-service | `services/knowledge-service/Dockerfile` | `sha256:c51e7d96e768acf87b39539912645126d60fe276d2c35258e7d48e7a3cbf1b52` |
| knowledge-indexer | `services/knowledge-service/Dockerfile.indexer` | `sha256:d8ac07f2e77958ad628cd6cbf950e7a263e2af21f3d7595b7e9a8aba1629a66b` |
| knowledge-parser | `services/knowledge-service/Dockerfile.parser` | `sha256:aa2c748672fe7fa50cd9330bfff9513ef750970a6fcd3c25d9cc6b08887dac0e` |
| grain-advisor | `services/grain-advisor/Dockerfile` | `sha256:032fde1dedad6c6d2d425ce55ff021f89fec143252456bf5c706733e940a2815` |
| mcp-gateway | `services/mcp-gateway/Dockerfile` | `sha256:88f2ffb8e314a260a89c2aadee3cb3e91eb566011de6b84d9b00ea185fedcbcc` |
| model-gateway | `services/model-gateway/Dockerfile` | `sha256:1df0903912b11f2ae6e0c896f96020408057326dd56f3b983b180595382d8f08` |
| model-gateway-usage | `services/model-gateway/Dockerfile.usage` | `sha256:97ac90f1dcede92c4b5901494b409f650d131836af969d8a47f09d0557c0e20c` |

The IDs above are exactly the local Docker `image inspect .Id` values; they
are **not verified ECR repository digests**. They must not be inserted into Terraform release inputs.
These images have not been pushed, signed, vulnerability-scanned or deployed
by this check. Runtime/provider connectivity, Kubernetes admission, health,
OIDC, tenant isolation and live assistant workflows remain acceptance gates.
## Synthetic ML scorer

Built `services/ml-scoring/deploy/Dockerfile` for linux/amd64 from `3a7409b`.
Build returned exit code 0 and image inspection reports amd64, user
`10001:10001`, local ID
`sha256:a480f9c3004b91d7e329f0efabfac5ccf4fbe2f7e7587f9c15f7fa356a8ded55`.
The image was run with no network, read-only filesystem, a 64 MiB temporary
filesystem, one CPU and 2 GiB memory. Its real `ModelRegistry.load` verified
manifest/artifact integrity and the packaged golden vector for
`i4-transformer-bcf286ab98d45f8c`, returning golden probability
`0.00010325924813514575`. The manifest remains `synthetic_only=true` and
`production_eligible=false`. This verifies loading and reproducible fixture
inference inside the built container, not predictive validity or the live
Kafka/database/alert workflow.

The knowledge-parser image also imported `pypdfium2`, `pdf_parser` and
`pdf_ocr` successfully with no network. These are dependency loading checks,
not a sandbox escape/security acceptance test.

Raw build and check logs remain privately on the operator workstation.
