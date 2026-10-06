"""Own-resource Docker acceptance for the chart Redis and ClamAV commands."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import time
import uuid
import runpy

ROOT = Path(__file__).resolve().parents[4]
CHART = Path(__file__).resolve().parent
LABEL = "greenguard.io/ai-local-acceptance"


class Acceptance:
    def __init__(self, args):
        self.args = args
        self.prefix = "gg-ai-deps-" + uuid.uuid4().hex[:10]
        self.owned = {"container": [], "volume": [], "network": []}
        self.passed = []
        self.private = Path(tempfile.mkdtemp(prefix=self.prefix + "-")); self.private.chmod(0o700)
        self.password = secrets.token_urlsafe(40)
        self.image_ids = {}
        self.objects = {}
        self.logs = {}
        self.source_hashes = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in CHART.rglob("*") if p.is_file()}

    def run(self, command, *, required=True, **kwargs):
        result = subprocess.run(command, capture_output=True, text=True, **kwargs)
        if required and result.returncode:
            raise RuntimeError((result.stderr or result.stdout or "command failed")[-4000:].replace(self.password, "[REDACTED]"))
        return result

    def resource(self, kind, name):
        self.owned[kind].append(name)
        return name

    def volume(self, suffix):
        name = self.resource("volume", self.prefix + "-" + suffix)
        self.run(["docker", "volume", "create", "--label", LABEL + "=" + self.prefix, name])
        return name

    def start(self, suffix, image, command, *, memory=128, uid=10001, detached=False, mounts=(), env=(), aliases=()):
        name = self.resource("container", self.prefix + "-" + suffix)
        argv = ["docker", "run", "--name", name, "--label", LABEL + "=" + self.prefix, "--network", self.prefix,
                "--memory", str(memory) + "m", "--memory-swap", str(memory) + "m", "--cpus", "2", "--read-only",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", str(uid) + ":10001"]
        if uid == 0: argv += ["--cap-add", "CHOWN"]
        for alias in aliases: argv += ["--network-alias", alias]
        for mount in mounts: argv += ["--mount", mount]
        for item in env: argv += ["--env", item]
        if detached: argv += ["-d"]
        argv += ["--entrypoint", command[0], image, *command[1:]]
        self.run(argv)
        return name

    def render(self):
        module = runpy.run_path(str(CHART / "test_chart.py"))
        values = module["fixture"](); values["images"]["clamav"] = self.args.clamav_image
        self.objects = {(item["kind"], item["metadata"]["name"]): item for item in module["render"](values)}
        for key, image in {"helper": self.args.helper_image, "clamav": self.args.clamav_image, "redis": "redis:7.4-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499"}.items():
            self.image_ids[key] = self.run(["docker", "image", "inspect", image, "--format", "{{.Id}}"]).stdout.strip()

    def bind(self, path, target, readonly=True):
        return "type=bind,src=" + str(path) + ",dst=" + target + (",readonly" if readonly else "")

    def mount(self, name, target, readonly=False):
        return "type=volume,src=" + name + ",dst=" + target + (",readonly" if readonly else "")

    def certificate(self):
        source = self.private / "redis-source"; source.mkdir(mode=0o700)
        self.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=Disposable AI local CA", "-keyout", str(source / "ca.key"), "-out", str(source / "ca.pem")])
        self.run(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=ai-redis.greenguard.svc.cluster.local", "-keyout", str(source / "server.key"), "-out", str(source / "server.csr")])
        ext = source / "extensions"; ext.write_text("subjectAltName=DNS:ai-redis,DNS:ai-redis.greenguard.svc,DNS:ai-redis.greenguard.svc.cluster.local\nextendedKeyUsage=serverAuth\n")
        self.run(["openssl", "x509", "-req", "-in", str(source / "server.csr"), "-CA", str(source / "ca.pem"), "-CAkey", str(source / "ca.key"), "-CAcreateserial", "-days", "2", "-extfile", str(ext), "-out", str(source / "server.crt")])
        (source / "password").write_text(self.password)
        # Docker mount permissions reproduce Kubernetes fsGroup projection.
        for file in source.iterdir(): file.chmod(0o444 if file.name in {"server.key", "server.crt", "ca.pem", "password"} else 0o600)
        source.chmod(0o755)
        return source

    def prepare_volume(self, name):
        self.start("prepare-" + name.rsplit("-", 1)[-1], self.image_ids["helper"], ["python", "-c", "import os; os.chmod('/volume',0o770); os.chown('/volume',10001,10001)"], uid=0, mounts=[self.mount(name, "/volume")])

    def redis(self):
        source = self.certificate()
        pod = self.objects[("Deployment", "ai-redis")]["spec"]["template"]["spec"]
        private = self.volume("redis-private"); data = self.volume("redis-data")
        self.prepare_volume(private); self.prepare_volume(data)
        self.start("redis-init", self.image_ids["helper"], pod["initContainers"][0]["command"], mounts=[self.bind(source, "/source"), self.mount(private, "/private")])
        envfile = self.private / "redis.env"; envfile.write_text("REDISCLI_AUTH=" + self.password + "\n"); envfile.chmod(0o600)
        # env-file keeps the generated password out of process argv.
        name = self.resource("container", self.prefix + "-redis")
        argv = ["docker", "run", "-d", "--name", name, "--label", LABEL + "=" + self.prefix, "--network", self.prefix,
                "--network-alias", "ai-redis.greenguard.svc.cluster.local", "--memory", "256m", "--memory-swap", "256m", "--read-only",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "10001:10001", "--env-file", str(envfile),
                "--mount", self.mount(private, "/private", True), "--mount", self.mount(data, "/data"), "--entrypoint", "redis-server", self.image_ids["redis"], "/private/redis.conf"]
        self.run(argv)
        probe = pod["containers"][0]["readinessProbe"]["exec"]["command"]
        for _ in range(30):
            if self.run(["docker", "exec", name, *probe], required=False).returncode == 0: break
            time.sleep(1)
        else: raise RuntimeError("Redis chart authenticated TLS readiness failed")
        self.passed.append("Chart Redis UID10001/private0600 config/read-only root starts and authenticated TLS readiness succeeds")
        client = self.private / "redis-client.py"
        client.write_text("""import pathlib,ssl,socket
host='ai-redis.greenguard.svc.cluster.local'
ctx=ssl.create_default_context(cafile='/source/ca.pem')
password=pathlib.Path('/source/password').read_text().strip()
def call(commands):
 with ctx.wrap_socket(socket.create_connection((host,6379),timeout=3),server_hostname=host) as s:
  results=[]
  for cmd in commands:
   s.sendall(('*'+str(len(cmd))+'\\r\\n'+''.join('$'+str(len(x.encode()))+'\\r\\n'+x+'\\r\\n' for x in cmd)).encode())
   results.append(s.recv(8192))
  return results
assert call([['PING']])[0].startswith(b'-NOAUTH')
assert call([['AUTH','wrong']])[0].startswith(b'-WRONGPASS')
assert call([['AUTH',password],['SET','owned-acceptance','verified'],['GET','owned-acceptance']])[-1].endswith(b'verified\\r\\n')
try:
 with ctx.wrap_socket(socket.create_connection((host,6379),timeout=3),server_hostname='wrong.example'): pass
except ssl.SSLCertVerificationError: pass
else: raise AssertionError('wrong TLS hostname accepted')
print('PASS TLS certificate/hostname, noauth/wrongpass denial and authenticated set/get')
""")
        self.start("redis-client", self.image_ids["helper"], ["python", "/client.py"], mounts=[self.bind(source, "/source"), self.bind(client, "/client.py")])
        self.passed.append("Redis verified TLS hostname; missing/wrong password denied; authenticated SET/GET succeeds")
        self.run(["docker", "rm", "-f", name])

    def clamav(self):
        config = self.private / "clamav-config"; config.mkdir(mode=0o755)
        for key, value in self.objects[("ConfigMap", "ai-clamav")]["data"].items():
            path = config / key; path.write_text(value); path.chmod(0o444)
        pod = self.objects[("Deployment", "clamav")]["spec"]["template"]["spec"]
        signatures = self.volume("clamav-signatures"); scratch = self.volume("clamav-scratch")
        self.prepare_volume(signatures); self.prepare_volume(scratch)
        # Seed only immutable image-bundled signatures, never a running service.
        self.start("clamav-seed", self.image_ids["clamav"], ["sh", "-c", "cp /var/lib/clamav/* /signatures/"], memory=128, mounts=[self.mount(signatures, "/signatures")])
        mounts = [self.bind(config, "/config"), self.mount(signatures, "/signatures"), self.mount(scratch, "/tmp")]
        self.start("clamav-init", self.image_ids["clamav"], pod["initContainers"][0]["command"], memory=2048, mounts=mounts)
        self.passed.append("Actual nonroot chart freshclam signature initialization succeeded with immutable image-bundled seed")
        main = self.start("clamav", self.image_ids["clamav"], pod["containers"][0]["command"], memory=2560, detached=True,
                          mounts=[self.bind(config, "/config"), self.mount(signatures, "/signatures", True), self.mount(scratch, "/tmp")], aliases=["clamav.greenguard.svc.cluster.local"])
        updater = self.start("clamav-updater", self.image_ids["clamav"], pod["containers"][1]["command"], memory=384, detached=True, mounts=mounts)
        probe = pod["containers"][0]["readinessProbe"]["exec"]["command"]
        for _ in range(120):
            if self.run(["docker", "exec", main, *probe], required=False).returncode == 0: break
            if self.run(["docker", "inspect", "--format", "{{.State.Running}}", main]).stdout.strip() != "true": raise RuntimeError("ClamAV exited before real clean-stream readiness")
            time.sleep(1)
        else: raise RuntimeError("ClamAV clean-stream readiness timed out")
        self.passed.append("Actual clamd clean-stream readiness and fresh signature marker pass; freshclam updater remains running")
        if self.run(["docker", "inspect", "--format", "{{.State.Running}}", updater]).stdout.strip() != "true": raise RuntimeError("Freshclam updater exited")
        client = self.private / "scan-client.py"
        client.write_text("""import socket,struct
def scan(data):
 with socket.create_connection(('clamav.greenguard.svc.cluster.local',3310),timeout=10) as s:
  s.sendall(b'zINSTREAM\\0'+struct.pack('!I',len(data))+data+struct.pack('!I',0))
  return s.recv(4096)
assert scan(b'%PDF-1.4\\n%%EOF').rstrip(b'\\0\\n') == b'stream: OK'
eicar=b'X5O!P%@AP[4\\\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
assert b'FOUND' in scan(eicar)
print('PASS actual clean PDF stream and harmless EICAR detection')
""")
        self.start("scan-client", self.image_ids["helper"], ["python", "/client.py"], memory=128, mounts=[self.bind(client, "/client.py")])
        self.passed.append("ClamAV actual INSTREAM clean PDF allowed and harmless EICAR test signature rejected")

    def cleanup(self):
        for kind in ("container", "volume", "network"):
            for name in reversed(self.owned[kind]):
                query = ["docker", "inspect", "--format", '{{index .Config.Labels "' + LABEL + '"}}', name] if kind == "container" else ["docker", kind, "inspect", "--format", '{{index .Labels "' + LABEL + '"}}', name]
                result = self.run(query, required=False)
                if result.returncode: continue
                if result.stdout.strip() != self.prefix: raise RuntimeError("Cleanup refused foreign resource")
                if kind == "container":
                    logs = self.run(["docker", "logs", name], required=False)
                    self.logs[name] = (logs.stdout + logs.stderr)[-4000:].replace(self.password, "[REDACTED]")
                self.run(["docker", *( ["rm", "-f", name] if kind == "container" else [kind, "rm", name])])
        remaining = []
        for kind in ("container", "volume", "network"):
            argv = ["docker", "ps", "-aq"] if kind == "container" else ["docker", kind, "ls", "-q"]
            result = self.run(argv + ["--filter", "label=" + LABEL + "=" + self.prefix])
            if result.stdout.strip(): remaining.append(kind)
        if remaining: raise RuntimeError("Owned resources remain after cleanup")
        self.passed.append("Zero own labeled containers, volumes or networks after cleanup")
        shutil.rmtree(self.private)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--clamav-image", required=True)
    parser.add_argument("--helper-image", required=True)
    args = parser.parse_args()
    check = Acceptance(args); failure = None
    try:
        check.render()
        check.resource("network", check.prefix)
        check.run(["docker", "network", "create", "--label", LABEL + "=" + check.prefix, check.prefix])
        check.redis(); check.clamav()
    except Exception as error:
        failure = str(error).replace(check.password, "[REDACTED]")
    finally:
        try: check.cleanup()
        except Exception as error: failure = (failure or "") + " cleanup: " + str(error)
    directory = ROOT / "evidence/disposable-ai-local"; directory.mkdir(parents=True, exist_ok=True)
    path = directory / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + check.prefix + ".json")
    path.write_text(json.dumps({"status": "PASS" if failure is None else "FAIL", "failure": failure,
                               "passed_assertions": check.passed, "source_sha256": check.source_hashes,
                               "images": check.image_ids, "owned_label": LABEL + "=" + check.prefix,
                               "local_memory_caps_mib": {"redis": 256, "signature_init": 2048, "clamd": 2560, "updater": 384, "helper": 128},
                               "fidelity_limits": ["Docker network substitutes Kubernetes; no NetworkPolicy/Argo/PVC/EBS or runsc proof", "Reduced local memory differs from chart, no concurrent signature reload capacity proof", "Immutable cached helper image, not final CI image provenance", "Seeded signature volume from immutable ClamAV image before exact chart freshclam initialization"],
                               "sanitized_logs": check.logs}, indent=2) + "\n")
    print(str(path))
    raise SystemExit(0 if failure is None else 1)


if __name__ == "__main__": main()
