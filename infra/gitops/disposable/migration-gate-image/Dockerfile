# The CI workflow supplies this kubectl binary only after checking the
# Kubernetes release's published SHA-256. Alpine is the same pinned base used
# elsewhere in this repository; the image contains only a shell, CA bundle,
# and the checksum-verified client used by the read-only migration gate.
FROM alpine@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
COPY --chmod=0555 infra/gitops/disposable/migration-gate-image/kubectl /usr/local/bin/kubectl
USER 65532:65532
ENTRYPOINT ["/bin/sh"]
