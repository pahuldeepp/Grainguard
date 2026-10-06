#!/usr/bin/env python3
"""Verify exact CI release digests are anonymously pullable by EKS nodes.

This is a read-only registry preflight. It does not prove node egress or image
startup inside EKS, and it never logs bearer tokens.
"""

import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


BASE = Path(__file__).resolve().parent
REGISTRY = "https://ghcr.io"
ACCEPT = ",".join((
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
))


def inventory(inputs, contract):
    required_fields = {
        "gitops_revision", "deployment_image_digests", "migration_image_digests",
        "migration_gate_image_digest", "migration_sql_image_digest", "ml_synthetic_scorer_image_digest",
        "observability_image_digests", "data_plane_image_digests", "opensearch_image_digest",
        "cassandra_image_digest", "mqtt_image_digest", "clickhouse_image_digest", "ai_runtime_image_digests",
    }
    if not isinstance(inputs, dict) or set(inputs) != required_fields:
        raise ValueError("release inputs must include every runtime, migration, platform, data-plane and AI image map")
    revision = inputs["gitops_revision"]
    if not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("gitops_revision must be an exact commit SHA")
    expected = {release["image"] for release in contract["releases"]}
    images = inputs["deployment_image_digests"]
    if not isinstance(images, dict) or set(images) != expected:
        raise ValueError("release image inventory does not match the deployment contract")
    for service, reference in images.items():
        prefix = f"ghcr.io/pahuldeepp/grainguard/{service}@sha256:"
        if not isinstance(reference, str) or not reference.startswith(prefix) or not re.fullmatch(
            r"[a-f0-9]{64}", reference.removeprefix(prefix)
        ):
            raise ValueError(f"{service}: expected an exact signed-CI GHCR digest reference")
    synthetic = inputs["ml_synthetic_scorer_image_digest"]
    verify_reference("ml-scoring-synthetic", synthetic)
    owner_inventory = json.loads((BASE / "owner-migration-inventory.json").read_text())
    expected_owners = {owner["name"] for owner in owner_inventory}
    migrations = inputs["migration_image_digests"]
    if not isinstance(migrations, dict) or set(migrations) != expected_owners:
        raise ValueError("owner migration image inventory does not match the migration contract")
    image_references = dict(images)
    image_references["ml-scoring-synthetic"] = synthetic
    for owner, reference in migrations.items():
        verify_reference(f"migration-{owner}", reference)
        image_references[f"migration-{owner}"] = reference
    for field, repository in (("migration_gate_image_digest", "migration-gate"),
                              ("migration_sql_image_digest", "migration-sql")):
        reference = inputs[field]
        verify_reference(repository, reference)
        image_references[repository] = reference
    observability_names = {"otel-collector", "prometheus", "grafana", "tempo", "loki"}
    observability = inputs["observability_image_digests"]
    if not isinstance(observability, dict) or set(observability) != observability_names:
        raise ValueError("observability image inventory must contain exactly the five Terraform keys")
    data_plane_names = {"pgbouncer", "kafka-topics", "kafka-connect", "connector-registration"}
    data_plane = inputs["data_plane_image_digests"]
    if not isinstance(data_plane, dict) or set(data_plane) != data_plane_names:
        raise ValueError("data-plane image inventory must contain exactly the four Terraform keys")
    platform = {**observability, **data_plane}
    for field, name in (("opensearch_image_digest", "opensearch"), ("cassandra_image_digest", "cassandra"),
                        ("mqtt_image_digest", "mqtt"), ("clickhouse_image_digest", "clickhouse")):
        platform[name] = inputs[field]
    ai_images = inputs["ai_runtime_image_digests"]
    ai_names = {"knowledge", "indexer", "parser", "advisor", "gateway", "usage", "mcp", "clamav"}
    if not isinstance(ai_images, dict) or set(ai_images) != ai_names:
        raise ValueError("AI runtime image inventory must contain exactly the eight Terraform keys")
    ai_repositories = {
        "knowledge": "knowledge-service", "indexer": "knowledge-indexer", "parser": "knowledge-parser",
        "advisor": "grain-advisor", "gateway": "model-gateway", "usage": "model-gateway-usage",
        "mcp": "mcp-gateway", "clamav": "clamav"
    }
    for key, repository in ai_repositories.items():
        verify_reference(repository, ai_images[key])
        image_references[repository] = ai_images[key]
    for name, reference in platform.items():
        verify_reference(name, reference)
        image_references[name] = reference
    return image_references


def verify_reference(repository, reference):
    prefix = f"ghcr.io/pahuldeepp/grainguard/{repository}@sha256:"
    if not isinstance(reference, str) or not reference.startswith(prefix) or not re.fullmatch(
        r"[a-f0-9]{64}", reference.removeprefix(prefix)
    ):
        raise ValueError(f"{repository}: expected an exact signed-CI GHCR digest reference")


def anonymous_manifest(service, reference, opener=urllib.request.urlopen):
    repository = f"pahuldeepp/grainguard/{service}"
    digest = reference.split("@", 1)[1]
    query = urllib.parse.urlencode({"scope": f"repository:{repository}:pull", "service": "ghcr.io"})
    token_request = urllib.request.Request(f"{REGISTRY}/token?{query}")
    with opener(token_request, timeout=20) as response:
        token = json.load(response).get("token")
    if not isinstance(token, str) or not token:
        raise ValueError(f"{service}: registry refused an anonymous pull token")
    request = urllib.request.Request(
        f"{REGISTRY}/v2/{repository}/manifests/{digest}",
        method="HEAD",
        headers={"Authorization": f"Bearer {token}", "Accept": ACCEPT},
    )
    with opener(request, timeout=20) as response:
        actual = response.headers.get("Docker-Content-Digest")
        if response.status != 200 or actual != digest:
            raise ValueError(f"{service}: registry returned a different manifest digest")


def main():
    if len(sys.argv) != 3:
        print("usage: check-public-release-images.py release-inputs.tfvars.json EXPECTED_GIT_SHA", file=sys.stderr)
        return 2
    try:
        inputs = json.loads(Path(sys.argv[1]).read_text())
        contract = json.loads((BASE / "contract.json").read_text())
        images = inventory(inputs, contract)
        if inputs["gitops_revision"] != sys.argv[2]:
            raise ValueError("release artifact revision differs from the selected Git checkout")
        for repository, reference in sorted(images.items()):
            anonymous_manifest(repository, reference)
            print(f"{repository}: anonymous immutable pull available")
    except (OSError, ValueError, KeyError, TypeError, urllib.error.URLError) as error:
        print(f"BLOCKED: public release image preflight failed: {error}", file=sys.stderr)
        return 1
    print(f"Verified {len(images)} public immutable runtime, migration and tool manifests for {inputs['gitops_revision']}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
