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
        "migration_gate_image_digest", "migration_sql_image_digest",
    }
    if not isinstance(inputs, dict) or set(inputs) != required_fields:
        raise ValueError("release inputs must contain runtime, all owner migration, and both migration tool digests")
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
    owner_inventory = json.loads((BASE / "owner-migration-inventory.json").read_text())
    expected_owners = {owner["name"] for owner in owner_inventory}
    migrations = inputs["migration_image_digests"]
    if not isinstance(migrations, dict) or set(migrations) != expected_owners:
        raise ValueError("owner migration image inventory does not match the migration contract")
    image_references = dict(images)
    for owner, reference in migrations.items():
        verify_reference(f"migration-{owner}", reference)
        image_references[f"migration-{owner}"] = reference
    for field, repository in (("migration_gate_image_digest", "migration-gate"),
                              ("migration_sql_image_digest", "migration-sql")):
        reference = inputs[field]
        verify_reference(repository, reference)
        image_references[repository] = reference
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
