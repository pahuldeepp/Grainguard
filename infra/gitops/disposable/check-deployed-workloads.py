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
    snapshot = json.loads(run(kubectl + ["get", "deployments,statefulsets,pods,cronjobs,jobs", "--namespace", "greenguard", "-o", "json"]))
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
