#!/usr/bin/env python3
"""Read-only post-apply application readiness gate; never substitutes for user journeys."""
import argparse
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
    expected = {item["image"] for item in contract["releases"]}
    if (not isinstance(release, dict) or set(release) != {"gitops_revision", "deployment_image_digests"} or
            not re.fullmatch(r"[a-f0-9]{40}", release.get("gitops_revision", "")) or
            not isinstance(release["deployment_image_digests"], dict) or set(release["deployment_image_digests"]) != expected):
        raise ValueError("invalid exact-revision image inventory")
    for service, image in release["deployment_image_digests"].items():
        ghcr = f"ghcr.io/pahuldeepp/grainguard/{service}"
        ecr = f"{cell['account_id']}.dkr.ecr.{cell['region']}.amazonaws.com/greenguard/{service}"
        if not isinstance(image, str) or not any(re.fullmatch(re.escape(repo) + r"@sha256:[a-f0-9]{64}", image) for repo in (ghcr, ecr)):
            raise ValueError(f"{service}: immutable image differs from this cell or release inventory")


def readiness(snapshot, release, contract):
    """Evaluate public workload fields; no Secret/config payloads are recorded."""
    failures = []
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
    for entry in contract["releases"]:
        name, expected_image = entry["name"], release["deployment_image_digests"][entry["image"]]
        selected = [obj for obj in items if obj.get("metadata", {}).get("labels", {}).get("app.kubernetes.io/instance") == name]
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
        if not current or not complete or len(runtime) != 1:
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
            if len(matches) != 1 or not runtime or matches[0].get("name") != runtime[0]:
                failures.append(f"{name}: pod image differs from selected release")
            elif not any(state.get("name") == runtime[0] and state.get("ready") is True and state.get("state", {}).get("running") is not None and state.get("imageID") for state in statuses):
                failures.append(f"{name}: runtime container has not started and become ready")
            if pod_status.get("phase") != "Running" or not ready:
                failures.append(f"{name}: pod readiness gate not satisfied")
    return failures


def command(args, timeout=30):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode:
        # CLI diagnostics can include credential material; return only command identity.
        raise ValueError(f"{args[0]} {args[1]} failed")
    return result.stdout


def collect(cell, kubeconfig, deadline=None):
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
    snapshot = json.loads(run(kubectl + ["get", "deployments,statefulsets,pods", "--namespace", "greenguard", "-o", "json"]))
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
    if not 1 <= args.timeout <= 1800:
        parser.error("timeout must be between 1 and 1800 seconds")
    try:
        cell = json.loads(Path(args.cell_identity).read_text())
        release = json.loads(Path(args.release_inputs).read_text())
        contract = json.loads((BASE / "contract.json").read_text())
        inputs(cell, release, contract)
        if not Path(args.kubeconfig).is_file():
            raise ValueError("explicit kubeconfig file required")
        deadline = time.monotonic() + args.timeout
        while True:
            failures = readiness(collect(cell, args.kubeconfig, deadline), release, contract)
            if not failures:
                print(f"PASS: {len(contract['releases'])} deployed application workloads ready at exact immutable images for {release['gitops_revision']}")
                print("User journeys, migrations/data integrity, telemetry and physical iPhone acceptance remain separate gates.")
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
