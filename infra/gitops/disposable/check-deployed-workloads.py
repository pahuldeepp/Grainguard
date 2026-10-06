#!/usr/bin/env python3
"""Read-only post-apply application readiness gate; never substitutes for user journeys."""
import argparse
import hashlib
import json
import re
import subprocess
import sys
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent


def _integer(value, field):
    # bool is a subclass of int in Python, but never a valid Kubernetes count.
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"invalid Kubernetes {field}")
    return value


def inputs(cell, release, contract):
    if not isinstance(cell, dict) or set(cell) != {"account_id", "region", "environment", "cluster_name"}:
        raise ValueError("invalid cell identity")
    if (not re.fullmatch(r"[0-9]{12}", cell.get("account_id", "")) or
            not re.fullmatch(r"[a-z]{2}-[a-z]+-[0-9]+", cell.get("region", "")) or
            not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", cell.get("cluster_name", "")) or
            not re.fullmatch(r"[a-z][a-z0-9-]{1,15}", cell.get("environment", "")) or cell["environment"].lower() in ("prod", "production")):
        raise ValueError("invalid or production cell scope")
    release = dict(release) if isinstance(release, dict) else release
    if isinstance(release, dict):
        ai_enabled = release.pop("ai_runtime_enabled", False)
        ai_images = release.pop("ai_runtime_image_digests", {})
        if not isinstance(ai_enabled, bool) or not isinstance(ai_images, dict):
            raise ValueError("invalid AI release inventory")
        repositories = {"knowledge":"knowledge-service", "indexer":"knowledge-indexer", "parser":"knowledge-parser", "advisor":"grain-advisor", "gateway":"model-gateway", "usage":"model-gateway-usage", "mcp":"mcp-gateway"}
        if ai_enabled:
            if set(ai_images) != set(repositories) | {"clamav"}:
                raise ValueError("AI release requires exact eight immutable images")
            for key, repository in repositories.items():
                scope = hashlib.sha256(cell["cluster_name"].encode()).hexdigest()[:16]
                origins = (f"ghcr.io/pahuldeepp/grainguard/{repository}", f"{cell['account_id']}.dkr.ecr.{cell['region']}.amazonaws.com/greenguard/{cell['environment']}/cell-{scope}/{repository}")
                if not isinstance(ai_images[key], str) or not any(re.fullmatch(re.escape(origin)+r"@sha256:[a-f0-9]{64}", ai_images[key]) for origin in origins):
                    raise ValueError("AI image must match approved repository and exact cell")
            if not re.fullmatch(r"(?:docker\.io/)?clamav/clamav@sha256:[a-f0-9]{64}", ai_images["clamav"]):
                raise ValueError("ClamAV requires reviewed official immutable image")
    expected = {item["image"] for item in contract["releases"]}
    acceptance_jobs = contract.get("acceptanceJobs")
    if not isinstance(acceptance_jobs, list) or not acceptance_jobs:
        raise ValueError("contract must require the PostgreSQL owner migration gate Job")
    job_names, selectors = set(), []
    postgres_gate = None
    for job in acceptance_jobs:
        if not isinstance(job, dict):
            raise ValueError("invalid acceptance Job contract")
        name, selector, images = job.get("name"), job.get("selector"), job.get("images")
        release_flag = job.get("releaseFlag")
        if (not isinstance(name, str) or not name or name in job_names
                or not isinstance(selector, dict) or not selector
                or any(not isinstance(key, str) or not key or not isinstance(value, str) or not value
                       for key, value in selector.items())
                or not isinstance(images, list) or not images
                or any(not isinstance(image, str) or not image for image in images)
                or (release_flag is not None and (not isinstance(release_flag, str) or not release_flag))):
            raise ValueError("invalid or duplicate acceptance Job name, selector or image inventory")
        if any(all(key not in prior or prior[key] == value for key, value in selector.items())
               and all(key not in selector or selector[key] == value for key, value in prior.items())
               for prior in selectors):
            raise ValueError("acceptance Job selectors must be mutually exclusive")
        job_names.add(name)
        selectors.append(selector)
        if name == "postgres-owner-migration-gate":
            postgres_gate = job
    if (postgres_gate is None
            or postgres_gate.get("selector") != {"greenguard.io/migration-gate": "true"}
            or postgres_gate.get("images") != ["migration-gate", "migration-sql"]):
        raise ValueError("contract must require the PostgreSQL owner migration gate Job")
    migration_owners = {owner["name"] for owner in json.loads((BASE / "owner-migration-inventory.json").read_text())}
    if (not isinstance(release, dict) or set(release) != {
            "gitops_revision", "deployment_image_digests", "migration_image_digests",
            "migration_gate_image_digest", "migration_sql_image_digest", "ml_synthetic_enabled",
            "ml_synthetic_scorer_image_digest", "managed_dex_enabled",
            "membership_acceptance_enabled", "clickhouse_image_digest"} or
            not isinstance(release.get("ml_synthetic_enabled"), bool) or
            not isinstance(release.get("managed_dex_enabled"), bool) or
            not isinstance(release.get("membership_acceptance_enabled"), bool) or
            release.get("membership_acceptance_enabled") and not release.get("managed_dex_enabled") or
            not re.fullmatch(r"[a-f0-9]{40}", release.get("gitops_revision", "")) or
            not isinstance(release["deployment_image_digests"], dict) or set(release["deployment_image_digests"]) != expected or
            not isinstance(release["migration_image_digests"], dict) or set(release["migration_image_digests"]) != migration_owners):
        raise ValueError("invalid exact-revision image inventory")
    clickhouse_image = release["clickhouse_image_digest"]
    clickhouse_ghcr = "ghcr.io/pahuldeepp/grainguard/clickhouse"
    clickhouse_ecr = f"{cell['account_id']}.dkr.ecr.{cell['region']}.amazonaws.com/greenguard/{cell['environment']}/cell-{hashlib.sha256(cell['cluster_name'].encode()).hexdigest()[:16]}/clickhouse"
    if not isinstance(clickhouse_image, str) or not any(
        re.fullmatch(re.escape(repo) + r"@sha256:[a-f0-9]{64}", clickhouse_image)
        for repo in (clickhouse_ghcr, clickhouse_ecr)
    ):
        raise ValueError("ClickHouse image must be an immutable approved GHCR or exact-cell ECR image")
    for job in acceptance_jobs:
        flag = job.get("releaseFlag")
        if flag is not None and flag not in release:
            raise ValueError(f"{job['name']}: release flag is absent from exact release inventory")
    ml_image = release["ml_synthetic_scorer_image_digest"]
    if release["ml_synthetic_enabled"]:
        ml_ghcr = "ghcr.io/pahuldeepp/grainguard/ml-scoring-synthetic"
        ml_ecr = f"{cell['account_id']}.dkr.ecr.{cell['region']}.amazonaws.com/greenguard/{cell['environment']}/cell-{hashlib.sha256(cell['cluster_name'].encode()).hexdigest()[:16]}/ml-scoring-synthetic"
        if not isinstance(ml_image, str) or not any(re.fullmatch(re.escape(repo) + r"@sha256:[a-f0-9]{64}", ml_image) for repo in (ml_ghcr, ml_ecr)):
            raise ValueError("ml-scoring-synthetic: image must be an immutable digest in the approved GHCR namespace or exact cell ECR path")
    elif ml_image != "" and (not isinstance(ml_image, str) or "@sha256:" not in ml_image):
        raise ValueError("ml-scoring-synthetic image reference is malformed")
    expected_images = dict(release["deployment_image_digests"])
    expected_images.update({f"migration-{owner}": image for owner, image in release["migration_image_digests"].items()})
    expected_images["migration-gate"] = release["migration_gate_image_digest"]
    expected_images["migration-sql"] = release["migration_sql_image_digest"]
    expected_images["clickhouse"] = clickhouse_image
    ecr_scope = f"greenguard/{cell['environment']}/cell-{hashlib.sha256(cell['cluster_name'].encode()).hexdigest()[:16]}"
    for job in acceptance_jobs:
        for image_name in job["images"]:
            if image_name not in expected_images:
                raise ValueError(f"{job['name']}: acceptance image is absent from the immutable release inventory")
    for service, image in expected_images.items():
        ghcr = f"ghcr.io/pahuldeepp/grainguard/{service}"
        ecr = f"{cell['account_id']}.dkr.ecr.{cell['region']}.amazonaws.com/{ecr_scope}/{service}"
        if not isinstance(image, str) or not any(re.fullmatch(re.escape(repo) + r"@sha256:[a-f0-9]{64}", image) for repo in (ghcr, ecr)):
            raise ValueError(f"{service}: immutable image differs from this cell or release inventory")


def readiness(snapshot, release, contract):
    """Evaluate public workload fields; no Secret/config payloads are recorded."""
    failures = []
    ml_image = release.get("ml_synthetic_scorer_image_digest", "")
    if not isinstance(snapshot, dict):
        raise ValueError("invalid Kubernetes workload snapshot")
    items = snapshot.get("items")
    if not isinstance(items, list):
        raise ValueError("invalid Kubernetes workload snapshot")
    for obj in items:
        if (not isinstance(obj, dict) or not isinstance(obj.get("kind"), str) or
                not isinstance(obj.get("metadata", {}), dict) or
                not isinstance(obj.get("metadata", {}).get("labels", {}), dict)):
            raise ValueError("invalid Kubernetes workload object")

    # Runtime Pods can remain Ready while Argo has an unresolved sync error or
    # has not applied the selected commit. Check the cell-scoped Applications
    # as well as their resulting workloads so Terraform waits for the actual
    # desired GitOps revision to converge.
    applications = [obj for obj in items if obj.get("kind") == "Application"
                    and obj.get("metadata", {}).get("labels", {}).get("greenguard.io/cell") ==
                    snapshot.get("cell_name")]
    application_names = [obj.get("metadata", {}).get("name") for obj in applications]
    expected_application_names = {f"greenguard-{entry['name']}" for entry in contract["releases"]}
    required_applications = contract.get("requiredApplications")
    if not isinstance(required_applications, list) or any(
        not isinstance(name, str) or not name for name in required_applications
    ):
        failures.append("contract declares invalid requiredApplications")
        required_applications = []
    expected_application_names.update(required_applications)
    if release["ml_synthetic_enabled"]:
        expected_application_names.update({"greenguard-ml-synthetic-data", "greenguard-ml-synthetic-scorer"})
    if release.get("ai_runtime_enabled", False):
        expected_application_names.update({"greenguard-ai-runtime", "greenguard-ai-database-bootstrap"})
    if release["managed_dex_enabled"]:
        expected_application_names.update({"greenguard-managed-dex", "greenguard-live-acceptance-probes"})
    for name in sorted(expected_application_names):
        if application_names.count(name) != 1:
            failures.append(f"{name}: expected exactly one cell-scoped Argo Application")
    if not applications:
        failures.append("no cell-scoped Argo Applications were returned")
    for app in applications:
        name = app.get("metadata", {}).get("name", "Argo Application")
        spec, status = app.get("spec", {}), app.get("status", {})
        source = spec.get("source", {}) if isinstance(spec, dict) else {}
        sync = status.get("sync", {}) if isinstance(status, dict) else {}
        health = status.get("health", {}) if isinstance(status, dict) else {}
        if (not isinstance(source, dict) or source.get("targetRevision") != release["gitops_revision"]
                or not isinstance(sync, dict) or sync.get("status") != "Synced"
                or sync.get("revision") != release["gitops_revision"]
                or not isinstance(health, dict) or health.get("status") != "Healthy"):
            failures.append(f"{name}: Argo sync, health or GitOps revision is not ready")
    if release.get("ai_runtime_enabled", False):
        gate_images = {"knowledge-migrate": "knowledge", "advisor-migrate": "advisor",
                       "model-gateway-migrate": "gateway", "parser-runtime": "indexer",
                       "budget-bootstrap": "gateway"}
        for gate, image_key in gate_images.items():
            jobs = [obj for obj in items if obj.get("kind") == "Job"
                    and obj.get("metadata", {}).get("labels", {}).get("greenguard.io/cell") == snapshot.get("cell_name")
                    and obj.get("metadata", {}).get("labels", {}).get("greenguard.io/ai-gate") == gate]
            if len(jobs) != 1:
                failures.append(f"AI {gate}: expected exactly one retained setup Job")
                continue
            job = jobs[0]
            status = job.get("status", {})
            containers = job.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
            expected = release["ai_runtime_image_digests"][image_key]
            if (len(containers) != 1 or containers[0].get("image") != expected
                    or status.get("succeeded") != 1 or status.get("failed", 0) != 0
                    or not any(c.get("type") == "Complete" and c.get("status") == "True"
                               for c in status.get("conditions", []))):
                failures.append(f"AI {gate}: setup Job has not completed at the immutable image")
            uid = job.get("metadata", {}).get("uid")
            pods = [obj for obj in items if obj.get("kind") == "Pod" and uid
                    and any(owner.get("uid") == uid and owner.get("controller") is True
                            for owner in obj.get("metadata", {}).get("ownerReferences", []))]
            def completed_at_image(pod):
                declared = pod.get("spec", {}).get("containers", [])
                actual = pod.get("status", {}).get("containerStatuses", [])
                return (pod.get("status", {}).get("phase") == "Succeeded"
                        and len(declared) == 1 and declared[0].get("image") == expected
                        and len(actual) == 1 and actual[0].get("name") == declared[0].get("name")
                        and bool(actual[0].get("imageID"))
                        and actual[0].get("state", {}).get("terminated", {}).get("exitCode") == 0)
            if len(pods) != 1 or not completed_at_image(pods[0]):
                failures.append(f"AI {gate}: completed owned runtime Pod proof is missing")

    runtime_entries = list(contract["releases"])
    if release.get("ai_runtime_enabled", False):
        profiles = {"knowledge-service":"knowledge", "knowledge-indexer":"indexer", "knowledge-relay":"knowledge", "knowledge-analytics":"knowledge", "knowledge-retention":"knowledge", "knowledge-summary":"knowledge", "grain-advisor":"advisor", "model-gateway":"gateway", "model-gateway-usage-relay":"usage", "model-gateway-usage-consume":"usage", "clamav":"clamav", "mcp-gateway":"mcp"}
        runtime_entries += [{"name": name, "ai_image": release["ai_runtime_image_digests"][key], "runtime_names": ["clamd", "freshclam"] if name == "clamav" else None} for name,key in profiles.items()]
        runtime_entries.append({"name":"ai-redis", "ai_image":"redis:7.4-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499"})
    for entry in runtime_entries:
        name = entry["name"]
        expected_image = entry.get("ai_image") or release["deployment_image_digests"][entry["image"]]
        selected = [obj for obj in items if (
            obj.get("metadata", {}).get("labels", {}).get("app.kubernetes.io/name" if "ai_image" in entry else "app.kubernetes.io/instance") == name)]
        workloads = [obj for obj in selected if obj.get("kind") in ("Deployment", "StatefulSet", "Rollout")]
        if len(workloads) != 1:
            failures.append(f"{name}: expected exactly one workload")
            continue
        obj = workloads[0]
        spec, status, metadata = obj.get("spec", {}), obj.get("status", {}), obj.get("metadata", {})
        if not isinstance(spec, dict) or not isinstance(status, dict):
            raise ValueError(f"{name}: invalid Kubernetes workload spec/status")
        desired = spec.get("replicas", 1)
        if not isinstance(desired, int) or isinstance(desired, bool) or desired < 1:
            failures.append(f"{name}: no active replicas")
            continue
        desired = _integer(desired, "desired replicas")
        generation = _integer(metadata.get("generation", 1), "generation")
        observed = _integer(status.get("observedGeneration", 0), "observed generation")
        updated = _integer(status.get("updatedReplicas", 0), "updated replicas")
        ready_replicas = _integer(status.get("readyReplicas", 0), "ready replicas")
        if obj["kind"] == "Rollout":
            # The ordinary charts default to Deployments. A rollout requires
            # its own controller-aware promotion/status acceptance, not Ready pods alone.
            failures.append(f"{name}: Argo Rollout requires controller-aware acceptance")
            continue
        current = observed >= generation
        complete = updated == desired and ready_replicas == desired
        if obj["kind"] == "Deployment":
            available = _integer(status.get("availableReplicas", 0), "available replicas")
            replicas = _integer(status.get("replicas", 0), "replicas")
            complete = complete and available == desired and replicas == desired
        else:
            current_revision, update_revision = status.get("currentRevision"), status.get("updateRevision")
            if current_revision is not None and not isinstance(current_revision, str):
                raise ValueError(f"{name}: invalid StatefulSet current revision")
            if update_revision is not None and not isinstance(update_revision, str):
                raise ValueError(f"{name}: invalid StatefulSet update revision")
            complete = complete and current_revision == update_revision and bool(update_revision)
        template = spec.get("template", {}).get("spec", {}).get("containers", [])
        if not isinstance(template, list) or any(not isinstance(container, dict) for container in template):
            raise ValueError(f"{name}: invalid workload container template")
        runtime = [container["name"] for container in template if container.get("image") == expected_image]
        expected_health = entry.get("health")
        if expected_health and runtime:
            runtime_container = next(container for container in template if container.get("name") == runtime[0])
            probe = runtime_container.get("readinessProbe", {})
            http_probe = probe.get("httpGet", {}) if isinstance(probe, dict) else {}
            tcp_probe = probe.get("tcpSocket", {}) if isinstance(probe, dict) else {}
            if isinstance(expected_health, str) and expected_health.startswith("/"):
                health_matches = isinstance(http_probe, dict) and http_probe.get("path") == expected_health
            elif isinstance(expected_health, str) and expected_health.startswith("tcp:") and expected_health[4:].isdigit():
                health_matches = isinstance(tcp_probe, dict) and tcp_probe.get("port") == int(expected_health[4:])
            elif (isinstance(expected_health, dict) and expected_health.get("type") == "exec"
                  and set(expected_health) == {"type", "command"}
                  and isinstance(expected_health.get("command"), list)):
                exec_probe = probe.get("exec", {}) if isinstance(probe, dict) else {}
                health_matches = isinstance(exec_probe, dict) and exec_probe.get("command") == expected_health["command"]
            else:
                health_matches = False
            if not health_matches:
                failures.append(f"{name}: readiness probe differs from deployment contract")
        if not current or not complete or (set(runtime) != set(entry["runtime_names"]) if entry.get("runtime_names") else len(runtime) != 1):
            failures.append(f"{name}: generation, replicas or immutable template image not ready")
        pods = [pod for pod in selected if pod.get("kind") == "Pod"]
        active = [pod for pod in pods if not pod.get("metadata", {}).get("deletionTimestamp") and pod.get("status", {}).get("phase") not in ("Succeeded", "Failed")]
        if len(active) != desired:
            failures.append(f"{name}: expected {desired} active pods")
        for pod in active:
            pod_status = pod.get("status", {})
            containers = pod.get("spec", {}).get("containers", [])
            if not isinstance(pod_status, dict) or not isinstance(containers, list) or any(not isinstance(container, dict) for container in containers):
                raise ValueError(f"{name}: invalid Kubernetes pod spec/status")
            matches = [container for container in containers if container.get("image") == expected_image]
            statuses = pod_status.get("containerStatuses", [])
            if not isinstance(statuses, list) or any(not isinstance(state, dict) for state in statuses):
                raise ValueError(f"{name}: invalid Kubernetes container statuses")
            ready = any(condition.get("type") == "Ready" and condition.get("status") == "True" for condition in pod_status.get("conditions", []))
            match_names = {container.get("name") for container in matches}
            if not runtime or len(matches) != len(runtime) or match_names != set(runtime):
                failures.append(f"{name}: pod image differs from selected release")
            elif any(not any(state.get("name") == container_name and state.get("ready") is True and state.get("state", {}).get("running") is not None and state.get("imageID") for state in statuses) for container_name in runtime):
                failures.append(f"{name}: runtime container has not started and become ready")
            if pod_status.get("phase") != "Running" or not ready:
                failures.append(f"{name}: pod readiness gate not satisfied")

    if release["ml_synthetic_enabled"]:
        ml_items = [obj for obj in items if obj.get("metadata", {}).get("namespace") == "ml-synthetic"]
        namespaces = [obj for obj in items if obj.get("kind") == "Namespace"
                      and obj.get("metadata", {}).get("name") == "ml-synthetic"]
        expected_scope = ":".join((snapshot.get("account_id", ""), snapshot.get("region", ""),
                                   snapshot.get("environment", ""), snapshot.get("cell_name", ""),
                                   snapshot.get("cell_name", "")))
        if len(namespaces) != 1:
            failures.append("ml-synthetic namespace: expected exactly one isolated namespace")
        else:
            namespace_meta = namespaces[0].get("metadata", {})
            labels, annotations = namespace_meta.get("labels", {}), namespace_meta.get("annotations", {})
            if (labels.get("greenguard.io/cell") != snapshot.get("cell_name")
                    or labels.get("greenguard.io/isolation") != "synthetic-only"
                    or labels.get("istio-injection") != "disabled"
                    or annotations.get("greenguard.io/terraform-scope") != expected_scope):
                failures.append("ml-synthetic namespace: cell, synthetic isolation, mesh or Terraform scope differs")
        for workload_name in ("ml-synthetic-postgres", "ml-synthetic-kafka", "ml-scoring-synthetic"):
            workload = [obj for obj in ml_items if obj.get("kind") in ("Deployment", "StatefulSet")
                        and obj.get("metadata", {}).get("name") == workload_name]
            if len(workload) != 1:
                failures.append(f"{workload_name}: expected exactly one synthetic ML workload")
                continue
            obj = workload[0]
            spec, status = obj.get("spec", {}), obj.get("status", {})
            if obj.get("metadata", {}).get("labels", {}).get("greenguard.io/cell") != snapshot.get("cell_name"):
                failures.append(f"{workload_name}: workload is missing the selected cell label")
            replicas = spec.get("replicas", 1) if isinstance(spec, dict) else 0
            if (replicas != 1 or not isinstance(status, dict)
                    or status.get("observedGeneration", 0) < obj.get("metadata", {}).get("generation", 1)
                    or status.get("readyReplicas", 0) != 1
                    or status.get("updatedReplicas", 0) != 1):
                failures.append(f"{workload_name}: synthetic ML workload is not fully Ready")
            containers = spec.get("template", {}).get("spec", {}).get("containers", []) if isinstance(spec, dict) else []
            if not isinstance(containers, list) or len(containers) != 1 or not isinstance(containers[0], dict):
                failures.append(f"{workload_name}: expected exactly one runtime container")
                continue
            for container in containers:
                if not re.search(r"@sha256:[a-f0-9]{64}$", container.get("image", "")):
                    failures.append(f"{workload_name}: mutable or invalid synthetic ML image")
                    break
            expected_image = ml_image if workload_name == "ml-scoring-synthetic" else None
            if expected_image and (containers[0].get("name") != "scorer" or containers[0].get("image") != expected_image):
                failures.append("ml-scoring-synthetic: running scorer image differs from pinned release digest")
            selector = spec.get("selector", {}).get("matchLabels", {}) if isinstance(spec, dict) else {}
            workload_meta = obj.get("metadata", {})
            if not isinstance(selector, dict) or not selector or not workload_meta.get("uid"):
                failures.append(f"{workload_name}: workload selector/UID is missing")
                continue
            pods = [pod for pod in ml_items if pod.get("kind") == "Pod"
                    and not pod.get("metadata", {}).get("deletionTimestamp")
                    and pod.get("status", {}).get("phase") not in ("Succeeded", "Failed")
                    and pod.get("metadata", {}).get("labels", {}).get("greenguard.io/cell") == snapshot.get("cell_name")
                    and all(pod.get("metadata", {}).get("labels", {}).get(key) == value for key, value in selector.items())]
            if len(pods) != 1:
                failures.append(f"{workload_name}: expected exactly one active owned Pod")
                continue
            pod = pods[0]
            owners = pod.get("metadata", {}).get("ownerReferences", [])
            statuses = pod.get("status", {}).get("containerStatuses", [])
            conditions = pod.get("status", {}).get("conditions", [])
            ready = isinstance(conditions, list) and any(
                item.get("type") == "Ready" and item.get("status") == "True" for item in conditions if isinstance(item, dict))
            running = isinstance(statuses, list) and len(statuses) == 1 and isinstance(statuses[0], dict) and statuses[0].get("ready") is True and isinstance(statuses[0].get("state"), dict) and isinstance(statuses[0]["state"].get("running"), dict) and bool(statuses[0].get("imageID"))
            controller_owner = next((owner for owner in owners if isinstance(owner, dict) and owner.get("controller") is True), None) if isinstance(owners, list) else None
            owned = controller_owner is not None and controller_owner.get("uid") == workload_meta.get("uid")
            if controller_owner is not None and obj.get("kind") == "Deployment":
                replica_sets = [item for item in ml_items if item.get("kind") == "ReplicaSet"
                                and item.get("metadata", {}).get("uid") == controller_owner.get("uid")]
                owned = len(replica_sets) == 1 and any(
                    owner.get("uid") == workload_meta.get("uid") and owner.get("controller") is True
                    for owner in replica_sets[0].get("metadata", {}).get("ownerReferences", [])
                    if isinstance(owner, dict))
            actual_containers = pod.get("spec", {}).get("containers", [])
            expected_container = containers[0]
            actual_valid = (isinstance(actual_containers, list) and len(actual_containers) == 1
                            and isinstance(actual_containers[0], dict))
            if (not owned or not ready or not running or pod.get("status", {}).get("phase") != "Running"
                    or not actual_valid
                    or actual_containers[0].get("name") != expected_container.get("name")
                    or actual_containers[0].get("image") != expected_container.get("image")
                    or statuses[0].get("name") != expected_container.get("name")):
                failures.append(f"{workload_name}: active Pod is not owned, running, Ready at its declared digest")
        for job_name, expected_image in (
            ("ml-synthetic-kafka-bootstrap", None),
            ("ml-scoring-synthetic-schema", ml_image),
            ("ml-scoring-synthetic-fixture-seed", ml_image),
        ):
            jobs = [obj for obj in ml_items if obj.get("kind") == "Job" and obj.get("metadata", {}).get("name") == job_name]
            if len(jobs) != 1:
                failures.append(f"{job_name}: expected exactly one retained synthetic ML setup Job")
                continue
            job = jobs[0]
            status = job.get("status", {})
            conditions = status.get("conditions", []) if isinstance(status, dict) else []
            if not any(condition.get("type") == "Complete" and condition.get("status") == "True"
                       for condition in conditions if isinstance(condition, dict)):
                failures.append(f"{job_name}: synthetic ML setup Job has not completed")
            job_spec = job.get("spec", {})
            pod = job_spec.get("template", {}).get("spec", {}) if isinstance(job_spec, dict) else {}
            containers = pod.get("containers", []) if isinstance(pod, dict) else []
            if (expected_image and sum(1 for container in containers if isinstance(container, dict)
                                       and container.get("image") == expected_image) != 1):
                failures.append(f"{job_name}: setup Job image differs from immutable scorer input")
            if expected_image is None and any(not isinstance(container, dict)
                                              or not re.search(r"@sha256:[a-f0-9]{64}$", container.get("image", ""))
                                              for container in containers):
                failures.append(f"{job_name}: Kafka setup Job uses a mutable or invalid image")
            if not containers:
                failures.append(f"{job_name}: setup Job has no runtime containers")
            if (_integer(status.get("succeeded", 0), f"{job_name} succeeded count") < 1
                    or _integer(status.get("failed", 0), f"{job_name} failed count") != 0):
                failures.append(f"{job_name}: setup Job has not succeeded cleanly")

    # Scheduled maintenance is part of the deployed contract too. These
    # sharded CronJobs are not Helm releases and therefore are invisible to
    # the release loop above. Require both the recurring task and its initial
    # Argo sync Job so a healthy API deployment cannot mask an unmaintained
    # shard or a failed first partition bootstrap.
    for task in contract.get("scheduledTasks", []):
        name = task.get("name")
        expected_image = release["deployment_image_digests"].get(task.get("image"))
        if not isinstance(name, str) or not expected_image:
            failures.append("scheduled task: invalid contract image or name")
            continue
        selected = [obj for obj in items
                    if obj.get("metadata", {}).get("labels", {}).get("app.kubernetes.io/instance") == name]
        cronjobs = [obj for obj in selected if obj.get("kind") == "CronJob"]
        if len(cronjobs) != 1:
            failures.append(f"{name}: expected exactly one CronJob")
        else:
            cronjob = cronjobs[0]
            spec = cronjob.get("spec", {})
            job_template = spec.get("jobTemplate", {}) if isinstance(spec, dict) else {}
            job_spec = job_template.get("spec", {}) if isinstance(job_template, dict) else {}
            template = job_spec.get("template", {}) if isinstance(job_spec, dict) else {}
            pod_spec = template.get("spec", {}) if isinstance(template, dict) else {}
            containers = pod_spec.get("containers", []) if isinstance(pod_spec, dict) else []
            if (not isinstance(spec, dict) or spec.get("schedule") != task.get("schedule")
                    or spec.get("suspend") is True or not isinstance(containers, list)
                    or sum(1 for container in containers if isinstance(container, dict)
                           and container.get("image") == expected_image) != 1):
                failures.append(f"{name}: schedule, suspension or immutable image differs from contract")
        initial_name = task.get("initialJob")
        initial_jobs = [obj for obj in selected if obj.get("kind") == "Job"
                        and obj.get("metadata", {}).get("name") == initial_name]
        if not isinstance(initial_name, str) or len(initial_jobs) != 1:
            failures.append(f"{name}: expected exactly one completed initial Job")
        else:
            job = initial_jobs[0]
            job_spec = job.get("spec", {})
            template = job_spec.get("template", {}) if isinstance(job_spec, dict) else {}
            pod_spec = template.get("spec", {}) if isinstance(template, dict) else {}
            containers = pod_spec.get("containers", []) if isinstance(pod_spec, dict) else []
            status = job.get("status", {})
            conditions = status.get("conditions", []) if isinstance(status, dict) else []
            succeeded = status.get("succeeded", 0) if isinstance(status, dict) else 0
            if (not isinstance(containers, list)
                    or sum(1 for container in containers if isinstance(container, dict)
                           and container.get("image") == expected_image) != 1
                    or not isinstance(conditions, list)
                    or not any(condition.get("type") == "Complete" and condition.get("status") == "True"
                               for condition in conditions if isinstance(condition, dict))
                    or _integer(succeeded, "initial Job succeeded count") < 1):
                failures.append(f"{name}: initial Job has not completed at the immutable image")

    # Argo's owner-migration Application can be healthy before all child
    # resources converge. Require every contract-declared acceptance Job to
    # finish; the mandatory PostgreSQL gate is only one of those jobs.
    acceptance_jobs = contract.get("acceptanceJobs")
    if not isinstance(acceptance_jobs, list) or not acceptance_jobs:
        failures.append("contract declares no required acceptance Jobs")
        acceptance_jobs = []
    for acceptance_job in acceptance_jobs:
        release_flag = acceptance_job.get("releaseFlag")
        if release_flag is not None and not release.get(release_flag, False):
            continue
        name = acceptance_job.get("name", "acceptance job")
        selector = acceptance_job.get("selector")
        if not isinstance(selector, dict) or not selector or any(
                not isinstance(key, str) or not isinstance(value, str)
                for key, value in selector.items()):
            failures.append(f"{name}: invalid acceptance Job selector")
            continue
        selected = [obj for obj in items if obj.get("kind") == "Job" and all(
            obj.get("metadata", {}).get("labels", {}).get(key) == value
            for key, value in selector.items())]
        if len(selected) != 1:
            failures.append(f"{name}: expected exactly one completed acceptance Job")
            continue
        job = selected[0]
        spec = job.get("spec", {})
        template = spec.get("template", {}) if isinstance(spec, dict) else {}
        pod_spec = template.get("spec", {}) if isinstance(template, dict) else {}
        init = pod_spec.get("initContainers", []) if isinstance(pod_spec, dict) else []
        containers = pod_spec.get("containers", []) if isinstance(pod_spec, dict) else []
        if not isinstance(init, list) or not isinstance(containers, list) or any(
                not isinstance(container, dict) for container in [*init, *containers]):
            failures.append(f"{name}: invalid acceptance Job container specification")
            continue
        image_fields = {
            "migration-gate": "migration_gate_image_digest",
            "migration-sql": "migration_sql_image_digest",
            "clickhouse": "clickhouse_image_digest",
        }
        tool_names = acceptance_job.get("images", [])
        if not isinstance(tool_names, list):
            failures.append(f"{name}: invalid acceptance Job image contract")
            continue
        expected_images = set()
        for tool in tool_names:
            if tool in image_fields:
                expected_images.add(release[image_fields[tool]])
            elif tool in release["deployment_image_digests"]:
                expected_images.add(release["deployment_image_digests"][tool])
            elif tool.startswith("migration-") and tool.removeprefix("migration-") in release["migration_image_digests"]:
                expected_images.add(release["migration_image_digests"][tool.removeprefix("migration-")])
            else:
                failures.append(f"{name}: acceptance image is absent from the immutable release inventory")
        actual_images = {container.get("image") for container in [*init, *containers]}
        if not expected_images.issubset(actual_images):
            failures.append(f"{name}: acceptance tools differ from immutable release inputs")
        status = job.get("status", {})
        conditions = status.get("conditions", []) if isinstance(status, dict) else []
        succeeded = status.get("succeeded", 0) if isinstance(status, dict) else 0
        failed = status.get("failed", 0) if isinstance(status, dict) else 0
        if (not isinstance(conditions, list)
                or not any(condition.get("type") == "Complete" and condition.get("status") == "True"
                           for condition in conditions if isinstance(condition, dict))
                or _integer(succeeded, "acceptance Job succeeded count") < 1
                or _integer(failed, "acceptance Job failed count") != 0):
            failures.append(f"{name}: acceptance Job has not completed successfully")
    return failures


def command(args, timeout=30):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode:
        # CLI diagnostics can include credential material; return only command identity.
        raise ValueError(f"{args[0]} {args[1]} failed")
    return result.stdout


def collect(cell, kubeconfig, deadline=None, release=None):
    def run(args):
        budget = 30 if deadline is None else min(30, deadline - time.monotonic())
        if budget <= 0:
            raise ValueError("workload readiness deadline exhausted")
        return command(args, timeout=budget)

    actual = run(["aws", "sts", "get-caller-identity", "--query", "Account", "--output", "text"]).strip()
    if actual != cell["account_id"]:
        raise ValueError("AWS account differs from saved cell identity")
    cluster = json.loads(run(["aws", "eks", "describe-cluster", "--region", cell["region"], "--name", cell["cluster_name"], "--output", "json"]))["cluster"]
    expected_arn = f"arn:aws:eks:{cell['region']}:{cell['account_id']}:cluster/{cell['cluster_name']}"
    if cluster.get("arn") != expected_arn or cluster.get("status") != "ACTIVE":
        raise ValueError("EKS cluster identity or status differs from saved scope")
    kubectl = ["kubectl", "--kubeconfig", str(kubeconfig), "--request-timeout=20s"]
    config = json.loads(run(kubectl + ["config", "view", "--minify", "--raw", "-o", "json"]))
    clusters = config.get("clusters", [])
    if len(clusters) != 1 or clusters[0].get("cluster", {}).get("server") != cluster["endpoint"]:
        raise ValueError("kubeconfig endpoint differs from saved EKS cluster")
    connection = clusters[0].get("cluster", {})
    if (connection.get("insecure-skip-tls-verify") or connection.get("tls-server-name") or
            not cluster.get("certificateAuthority", {}).get("data") or
            connection.get("certificate-authority-data") != cluster["certificateAuthority"]["data"]):
        raise ValueError("kubeconfig TLS trust differs from saved EKS cluster")
    if run(kubectl + ["get", "--raw=/readyz"]).strip() != "ok":
        raise ValueError("private EKS API is not ready/reachable from this runner")
    snapshot = json.loads(run(kubectl + ["get", "deployments,statefulsets,replicasets,pods,cronjobs,jobs", "--namespace", "greenguard", "-o", "json"]))
    snapshot["cell_name"] = cell["cluster_name"]
    if release is not None and release.get("ml_synthetic_enabled"):
        snapshot["account_id"] = cell["account_id"]
        snapshot["region"] = cell["region"]
        snapshot["environment"] = cell["environment"]
        ml_snapshot = json.loads(run(kubectl + ["get", "deployments,statefulsets,replicasets,pods,cronjobs,jobs", "--namespace", "ml-synthetic", "-o", "json"]))
        if not isinstance(ml_snapshot, dict) or not isinstance(ml_snapshot.get("items"), list):
            raise ValueError("invalid synthetic ML workload snapshot")
        snapshot["items"].extend(ml_snapshot["items"])
        namespace = json.loads(run(kubectl + ["get", "namespace", "ml-synthetic", "-o", "json"]))
        snapshot["items"].append(namespace)
    applications = json.loads(run(kubectl + ["get", "applications.argoproj.io", "--namespace", "argocd",
                                              "--selector", f"greenguard.io/cell={cell['cluster_name']}", "-o", "json"]))
    if not isinstance(applications, dict) or not isinstance(applications.get("items"), list):
        raise ValueError("invalid cell-scoped Argo Application snapshot")
    snapshot["items"].extend(applications["items"])
    resources = run(kubectl + ["api-resources", "--api-group=argoproj.io", "--verbs=list", "-o", "name"]).splitlines()
    if "rollouts.argoproj.io" in resources:
        rollouts = json.loads(run(kubectl + ["get", "rollouts.argoproj.io", "--namespace", "greenguard", "-o", "json"]))
        snapshot["items"].extend(rollouts["items"])
    return snapshot


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cell_identity")
    parser.add_argument("release_inputs")
    parser.add_argument("kubeconfig")
    parser.add_argument("--timeout", type=int, default=900)
    args = parser.parse_args(argv)
    if not 1 <= args.timeout <= 3600:
        parser.error("timeout must be between 1 and 3600 seconds")
    try:
        cell = json.loads(Path(args.cell_identity).read_text())
        release = json.loads(Path(args.release_inputs).read_text())
        contract = json.loads((BASE / "contract.json").read_text())
        inputs(cell, release, contract)
        if not Path(args.kubeconfig).is_file():
            raise ValueError("explicit kubeconfig file required")
        deadline = time.monotonic() + args.timeout
        while True:
            failures = readiness(collect(cell, args.kubeconfig, deadline, release), release, contract)
            if not failures:
                print(f"PASS: {len(contract['releases'])} application workloads and all cell Argo Applications are ready at exact immutable images/revision {release['gitops_revision']}")
                print("PostgreSQL migration/RLS gate passed. Non-PostgreSQL data integrity, user journeys, telemetry and physical iPhone acceptance remain separate gates.")
                return 0
            if time.monotonic() >= deadline:
                print("BLOCKED: " + "; ".join(failures), file=sys.stderr)
                return 1
            time.sleep(min(5, max(0, deadline - time.monotonic())))
    except json.JSONDecodeError:
        print("BLOCKED: deployed workload check received invalid JSON", file=sys.stderr)
        return 1
    except (OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired) as error:
        print(f"BLOCKED: deployed workload check failed ({type(error).__name__}: {error if isinstance(error, ValueError) else 'invalid or unavailable input/API'})", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
