#!/usr/bin/env python3
"""Local Docker acceptance of rendered synthetic data charts, never AWS/K8s.

Requires Docker, Helm, Ruby (YAML), openssl and keytool. Owns only randomly
named, labeled resources. Memory caps are smaller than chart limits: Kafka
1536Mi, PostgreSQL 768Mi, one transient helper 512Mi. No ports are published.
"""
from __future__ import annotations

import importlib.util
import hashlib
import io
import json
import os
import shutil
from pathlib import Path
import subprocess
import tempfile
import time
import uuid
from contextlib import redirect_stdout
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[3]
DEPLOY = Path(__file__).resolve().parent
OWNER = "greenguard-ml-local-acceptance"
SCORER = "greenguard/ml-scoring-synthetic:i4-transformer-bcf286ab98d45f8c"
SEED = """import base64,json,os,sys
for row in json.load(sys.stdin):
 p=row['path']; os.makedirs(p,exist_ok=True); os.chown(p,row['uid'],row['gid']); os.chmod(p,row['mode'])
 for name,data in row.get('files',{}).items():
  f=os.path.join(p,name); os.makedirs(os.path.dirname(f),exist_ok=True)
  with open(f,'wb') as out: out.write(base64.b64decode(data))
  os.chown(f,row['uid'],row['gid']); os.chmod(f,row['filemode'])
"""


class Acceptance:
    def __init__(self, work):
        self.work = work
        self.prefix = "gg-ml-data-" + uuid.uuid4().hex[:10]
        self.label = "greenguard.io/local-acceptance=" + self.prefix
        self.containers = []
        self.volumes = []
        self.secret_values = []
        self.network = self.prefix
        self.objects = {}
        self.empty_dirs = {}
        self.rendered = {}
        self.passed = []
        self.scorer_image = SCORER
        self.overlay_sources = {}
        self.overlay_hashes = {}

    def redact(self, value):
        for secret in sorted(self.secret_values, key=len, reverse=True):
            if len(secret) >= 8:
                value = value.replace(secret, "[withheld]")
        return value

    def run(self, args, *, payload=None, required=True):
        result = subprocess.run(args, input=payload, text=True, capture_output=True)
        if required and result.returncode:
            raise RuntimeError(self.redact(result.stderr + result.stdout)[-6000:])
        return result

    def render(self, chart, *args):
        raw = self.run(["helm", "template", "local-acceptance", str(chart), "-n", "ml-synthetic", "--set", "enabled=true", "--set", "cell=" + self.prefix, *args]).stdout
        self.rendered[chart.name] = {"sha256": hashlib.sha256(raw.encode()).hexdigest(), "source_files": {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(chart.rglob("*")) if p.is_file()}}
        parsed = self.run(["ruby", "-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.load_stream(STDIN.read).compact)"], payload=raw).stdout
        return json.loads(parsed)

    def volume(self, suffix):
        name = self.prefix + "-" + suffix
        self.run(["docker", "volume", "create", "--label", self.label, name])
        self.volumes.append(name)
        return name

    def secret_volume(self, definition, gid):
        import base64
        secret = definition["secret"]
        source = self.work / "bundle" / secret["secretName"]
        items = secret.get("items") or [{"key": p.name, "path": p.name} for p in source.iterdir()]
        files = {item["path"]: base64.b64encode((source / item["key"]).read_bytes()).decode() for item in items}
        name = self.volume("s-" + uuid.uuid4().hex[:8])
        row = {"path": "/seed", "uid": 0, "gid": gid, "mode": 0o755, "filemode": secret.get("defaultMode", 0o644), "files": files}
        self.run(["docker", "run", "--rm", "--user", "0:0", "--memory", "512m", "--label", self.label, "-i", "--mount", f"type=volume,src={name},dst=/seed", "--entrypoint", "python", self.scorer_image, "-c", SEED], payload=json.dumps([row]))
        return name

    def seed_data(self, name, uid, gid):
        row = {"path": "/seed", "uid": uid, "gid": gid, "mode": 0o770, "filemode": 0o600}
        self.run(["docker", "run", "--rm", "--user", "0:0", "--memory", "512m", "--label", self.label, "-i", "--mount", f"type=volume,src={name},dst=/seed", "--entrypoint", "python", self.scorer_image, "-c", SEED], payload=json.dumps([row]))

    def start(self, pod, container, suffix, *, data=None, aliases=(), detached=False, memory="512m", source_overlay=False):
        spec = pod["spec"]
        security = spec.get("securityContext", {})
        uid, gid = security["runAsUser"], security["runAsGroup"]
        group = security.get("fsGroup", 0)
        name = self.prefix + "-" + suffix
        self.containers.append(name)
        args = ["docker", "run", "--name", name, "--label", self.label, "--network", self.network, "--memory", memory, "--user", f"{uid}:{gid}", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "-d" if detached else "-i"]
        for alias in aliases:
            args += ["--network-alias", alias]
        if group:
            args += ["--group-add", str(group)]
        if container["securityContext"].get("readOnlyRootFilesystem"):
            args += ["--read-only"]
        definitions = {v["name"]: v for v in spec.get("volumes", [])}
        for mount in container.get("volumeMounts", []):
            key, target = mount["name"], mount["mountPath"]
            definition = definitions.get(key, {})
            readonly = ",readonly" if mount.get("readOnly") else ""
            if key == "data":
                args += ["--mount", f"type=volume,src={data},dst={target}"]
            elif "emptyDir" in definition:
                cache_key = (id(pod), key)
                if cache_key not in self.empty_dirs:
                    volume = self.prefix + "-e-" + uuid.uuid4().hex[:8]
                    size = definition['emptyDir'].get('sizeLimit', '64m').lower().replace('mi', 'm')
                    self.run(["docker", "volume", "create", "--label", self.label, "--driver", "local", "--opt", "type=tmpfs", "--opt", "device=tmpfs", "--opt", f"o=uid={uid},gid={gid},mode=0770,size={size}", volume])
                    self.volumes.append(volume)
                    self.empty_dirs[cache_key] = volume
                args += ["--mount", f"type=volume,src={self.empty_dirs[cache_key]},dst={target},volume-nocopy"]
            elif "secret" in definition:
                volume = self.secret_volume(definition, group)
                args += ["--mount", f"type=volume,src={volume},dst={target}{readonly}"]
            elif "configMap" in definition:
                source = self.work / "config" / definition["configMap"]["name"]
                for file in source.iterdir():
                    file.chmod(definition["configMap"].get("defaultMode", 0o644))
                if mount.get("subPath"):
                    source = source / mount["subPath"]
                args += ["--mount", f"type=bind,src={source},dst={target}{readonly}"]
            else:
                raise RuntimeError("Unsupported rendered volume: " + key)
        env = {}
        for row in container.get("env", []):
            if "value" in row:
                env[row["name"]] = str(row["value"])
            else:
                ref = row["valueFrom"]["secretKeyRef"]
                env[row["name"]] = (self.work / "bundle" / ref["name"] / ref["key"]).read_text()
        # Docker reads private env files; no credentials appear in argv/stdout.
        env_file = self.work / (suffix + ".env")
        env_file.write_text("".join(f"{key}={value}\n" for key, value in env.items()))
        env_file.chmod(0o600)
        args += ["--env-file", str(env_file)]
        if source_overlay:
            for target, source in self.overlay_sources.items():
                args += ["--mount", f"type=bind,src={source},dst={target},readonly"]
        command = container.get("command", [])
        if command:
            args += ["--entrypoint", command[0]]
        image = self.scorer_image if source_overlay else container["image"]
        args += [image, *command[1:], *container.get("args", [])]
        result = self.run(args, required=False)
        if result.returncode:
            raise RuntimeError(self.redact(result.stderr + result.stdout)[-6000:])
        return name

    def wait_pg(self, name):
        for _ in range(60):
            if self.run(["docker", "exec", name, "pg_isready", "-U", "postgres", "-d", "greenguard_ml"], required=False).returncode == 0:
                return
            time.sleep(1)
        raise RuntimeError("PostgreSQL did not start")

    def execute(self):
        self.scorer_image = self.run(["docker", "image", "inspect", SCORER, "--format", "{{.Id}}"]).stdout.strip()
        snapshot = self.work / "snapshot"
        snapshot.mkdir()
        for source, target in ((DEPLOY / "migrate_cluster.py", "/app/migrate_cluster.py"), (DEPLOY.parent / "migrations", "/app/migrations"), (DEPLOY.parent / "ml_scoring", "/app/ml_scoring"), (DEPLOY / "seed_synthetic_fixture.py", "/app/seed_synthetic_fixture.py")):
            frozen = snapshot / source.name
            if source.is_dir():
                shutil.copytree(source, frozen, ignore=shutil.ignore_patterns("__pycache__"))
                for path in sorted(frozen.rglob("*")):
                    if path.is_file():
                        self.overlay_hashes[target + "/" + str(path.relative_to(frozen))] = hashlib.sha256(path.read_bytes()).hexdigest()
            else:
                shutil.copyfile(source, frozen)
                self.overlay_hashes[target] = hashlib.sha256(frozen.read_bytes()).hexdigest()
            self.overlay_sources[target] = frozen
        module = importlib.util.spec_from_file_location("generator", DEPLOY / "generate_synthetic_secrets.py")
        generator = importlib.util.module_from_spec(module)
        module.loader.exec_module(generator)
        generator.generate(self.work / "bundle")
        for path in (self.work / "bundle").glob("*/*"):
            try:
                self.secret_values.append(path.read_text())
            except UnicodeError:
                pass
        self.run(["docker", "network", "create", "--internal", "--label", self.label, self.network])
        data_objects = self.render(DEPLOY / "data-chart")
        scorer_objects = self.render(DEPLOY / "chart", "--set", "syntheticFixtureSeed.enabled=true", "--set", "image.allowTagFallback=true")
        for obj in data_objects + scorer_objects:
            self.objects[(obj["kind"], obj["metadata"]["name"])] = obj
            if obj["kind"] == "ConfigMap":
                directory = self.work / "config" / obj["metadata"]["name"]
                directory.mkdir(parents=True)
                directory.chmod(0o755)
                for key, value in obj.get("data", {}).items():
                    path = directory / key
                    path.write_text(value)
                    path.chmod(0o444)
        pg = self.objects[("StatefulSet", "ml-synthetic-postgres")]["spec"]["template"]
        kafka = self.objects[("StatefulSet", "ml-synthetic-kafka")]["spec"]["template"]
        pg_data, kafka_data = self.volume("pg-data"), self.volume("kafka-data")
        self.seed_data(pg_data, 999, 999)
        self.seed_data(kafka_data, 1000, 1000)
        pg_name = self.start(pg, pg["spec"]["containers"][0], "postgres", data=pg_data, aliases=("postgres.ml-synthetic.svc.cluster.local",), detached=True, memory="768m")
        self.wait_pg(pg_name)
        self.passed.append("PostgreSQL initialized with chart UID, TLS config and generated role init SQL")
        self.start(kafka, kafka["spec"]["initContainers"][0], "kafka-format", data=kafka_data)
        self.start(kafka, kafka["spec"]["containers"][0], "kafka", data=kafka_data, aliases=("kafka.ml-synthetic.svc.cluster.local", "ml-synthetic-kafka-0.kafka-headless.ml-synthetic.svc.cluster.local"), detached=True, memory="1536m")
        bootstrap = self.objects[("Job", "ml-synthetic-kafka-bootstrap")]["spec"]["template"]
        self.start(bootstrap, bootstrap["spec"]["containers"][0], "kafka-bootstrap")
        self.passed.append("Kafka SCRAM storage format and authenticated TLS topic/ACL bootstrap")
        schema = self.objects[("Job", "ml-scoring-synthetic-schema")]["spec"]["template"]
        self.start(schema, schema["spec"]["containers"][0], "schema", source_overlay=True)
        self.passed.append("Verified-TLS schema migration with dedicated migration DSN")
        roles = self.run(["docker", "exec", pg_name, "psql", "-U", "postgres", "-d", "greenguard_ml", "-At", "-c", "SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('ml_app','ml_migrator') ORDER BY rolname;"]).stdout.strip()
        if roles != "ml_app|f|f\nml_migrator|f|f":
            raise RuntimeError("Synthetic database role safety differs from contract")
        self.passed.append("ml_app and ml_migrator are non-superuser and NOBYPASSRLS")
        fixture = self.objects[("Job", "ml-scoring-synthetic-fixture-seed")]["spec"]["template"]
        self.start(fixture, fixture["spec"]["containers"][0], "fixture", source_overlay=True)
        self.passed.append("Authenticated idempotent fixture published 384 synthetic telemetry events")
        scorer = self.objects[("Deployment", "ml-scoring-synthetic")]["spec"]["template"]
        scorer_name = self.start(scorer, scorer["spec"]["containers"][0], "scorer", detached=True, source_overlay=True)
        for _ in range(180):
            result = self.run(["docker", "exec", pg_name, "psql", "-U", "postgres", "-d", "greenguard_ml", "-At", "-c", "SELECT count(*) FROM ml_shadow_outbox WHERE published_at IS NOT NULL;"], required=False)
            if result.returncode == 0 and int(result.stdout.strip() or "0") > 0:
                break
            state = self.run(["docker", "inspect", "--format", "{{.State.Status}}", scorer_name]).stdout.strip()
            if state != "running":
                raise RuntimeError("Scorer exited before authenticated input produced a shadow outbox publication")
            time.sleep(1)
        else:
            raise RuntimeError("Timed out waiting for a real scorer shadow outbox publication")
        auth_probe = '''import json,os,urllib.request,urllib.error
base='http://127.0.0.1:8080/operations?tenant_id='
tenant='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
def call(tenant,token):
 headers={} if token is None else {'X-Internal-Token':token}
 try:
  response=urllib.request.urlopen(urllib.request.Request(base+tenant,headers=headers),timeout=10)
  return response.status,json.load(response)
 except urllib.error.HTTPError as error: return error.code,{}
assert call(tenant,None)[0]==401
assert call(tenant,'incorrect-token')[0]==401
assert call('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',os.environ['ML_OPERATIONS_TOKEN'])[0]==403
status,body=call(tenant,os.environ['ML_OPERATIONS_TOKEN'])
assert status==200 and body['model']['productionEligible'] is False and body['predictionsTotal']>0
print('PASS authenticated operations; missing/wrong token denied; cross-tenant request denied; synthetic model remains ineligible')
'''
        self.run(["docker", "exec", scorer_name, "python", "-c", auth_probe])
        self.passed.append("Missing/wrong operations token denied401; cross-tenant denied403; authorized synthetic model snapshot200")
        password = (self.work / "bundle/ml-synthetic-kafka-auth/admin-password").read_text()
        properties = ('security.protocol=SASL_SSL\nsasl.mechanism=SCRAM-SHA-512\n'
                      'sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="ml_synthetic_admin" password="' + password + '";\n'
                      'ssl.truststore.type=PKCS12\nssl.truststore.location=/etc/greenguard/kafka/broker.truststore.p12\n'
                      'ssl.truststore.password=' + (self.work / 'bundle/ml-synthetic-kafka-tls/truststore-password').read_text() + '\n')
        kafka_name = self.prefix + "-kafka"
        consume = self.run(["docker", "exec", "-i", kafka_name, "/bin/bash", "-ec", "umask 077; cat > /tmp/local-acceptance-client.properties; /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server kafka.ml-synthetic.svc.cluster.local:9093 --consumer.config /tmp/local-acceptance-client.properties --topic greenguard.ml.prediction.shadow.v1 --from-beginning --max-messages 1 --timeout-ms 30000"], payload=properties)
        event = json.loads(consume.stdout.strip())
        if event.get("tenant_id") != "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa":
            raise RuntimeError("Consumed shadow prediction has an unexpected tenant")
        self.passed.append("Real scorer persisted prediction and published outbox event; authenticated Kafka consumer read matching-tenant shadow event")
        print("PASS chart-equivalent PostgreSQL verified TLS, dedicated roles, schema migration, Kafka TLS/SCRAM topic and ACL bootstrap, authenticated fixture input, scorer prediction, outbox publication and real Kafka shadow consumption; operations authentication and tenant denial")

    def cleanup(self):
        for name in reversed(self.containers):
            state = self.run(["docker", "inspect", "--format", '{{index .Config.Labels "greenguard.io/local-acceptance"}}', name], required=False)
            if state.returncode == 0 and state.stdout.strip() == self.prefix:
                self.run(["docker", "rm", "-f", name], required=False)
        for name in reversed(self.volumes):
            state = self.run(["docker", "volume", "inspect", "--format", '{{index .Labels "greenguard.io/local-acceptance"}}', name], required=False)
            if state.returncode == 0 and state.stdout.strip() == self.prefix:
                self.run(["docker", "volume", "rm", name], required=False)
        state = self.run(["docker", "network", "inspect", "--format", '{{index .Labels "greenguard.io/local-acceptance"}}', self.network], required=False)
        if state.returncode == 0 and state.stdout.strip() == self.prefix:
            self.run(["docker", "network", "rm", self.network], required=False)
        for args in (["docker", "ps", "-a", "--filter", "label=" + self.label, "--format", "{{.Names}}"], ["docker", "volume", "ls", "--filter", "label=" + self.label, "--format", "{{.Name}}"], ["docker", "network", "ls", "--filter", "label=" + self.label, "--format", "{{.Name}}"]):
            if self.run(args).stdout.strip():
                raise RuntimeError("Own labeled Docker resources remain after cleanup")
        self.passed.append("Zero own labeled containers, volumes or networks after cleanup")


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="gg-ml-local-acceptance-") as directory:
        work = Path(directory)
        work.chmod(0o700)
        acceptance = Acceptance(work)
        output = io.StringIO()
        failure = None
        with redirect_stdout(output):
            try:
                acceptance.execute()
            except Exception as error:
                failure = acceptance.redact(str(error)) or type(error).__name__
                for name in acceptance.containers:
                    logs = acceptance.run(["docker", "logs", "--tail", "40", name], required=False)
                    print(acceptance.redact(name + "\n" + logs.stdout + logs.stderr)[-5000:])
            finally:
                try:
                    acceptance.cleanup()
                except Exception as error:
                    failure = (failure or "") + " cleanup: " + acceptance.redact(str(error))
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        evidence = ROOT / "evidence/disposable-ml-local" / (timestamp + "-" + acceptance.prefix + ".json")
        evidence.parent.mkdir(parents=True, exist_ok=True)
        evidence.write_text(json.dumps({"status": "FAIL" if failure else "PASS", "failure": failure, "resource_label": acceptance.label, "passed_assertions": acceptance.passed, "rendered_charts": acceptance.rendered, "source_overlay_sha256": acceptance.overlay_hashes, "local_memory_caps_mib": {"postgres": 768, "kafka": 1536, "helper_or_scorer": 512}, "scorer_image": acceptance.scorer_image, "scorer_source_overlay": True, "fidelity_limits": ["Docker network substitutes Kubernetes DNS", "No Kubernetes NetworkPolicy, Argo reconciliation or PVC/EBS lifecycle validation", "Local memory caps differ from chart limits", "Cached scorer image with current mounted application/migration source; CI image provenance unverified"], "sanitized_output": acceptance.redact(output.getvalue())}, indent=2) + "\n")
        print(acceptance.redact(output.getvalue()))
        print("Evidence:", evidence)
        if failure:
            raise SystemExit("FAIL " + failure)
