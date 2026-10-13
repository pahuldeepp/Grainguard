"""Offline render and verified-token unit contracts for acceptance probe Jobs."""
import json
import os
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

CHART = Path(__file__).resolve().parent
PROBE = CHART / "files" / "tenant-membership-readback.mjs"


def fixture():
    return {
        "clickhouseEnabled": True,
        "membershipEnabled": True,
        "namespace": "greenguard",
        "cell": "green-guard-test",
        "revision": "a" * 40,
        "clickhouseImage": "clickhouse/clickhouse-server@sha256:" + "b" * 64,
        "tenantControlPlaneImage": "ghcr.io/pahuldeepp/grainguard/tenant-control-plane@sha256:" + "c" * 64,
        "membershipAudience": "greenguard-dashboard",
    }


def render(values=None, namespace="greenguard"):
    with tempfile.TemporaryDirectory(prefix="gg-acceptance-probes-") as temporary:
        command = ["helm", "template", "acceptance-probes", str(CHART), "--namespace", namespace]
        if values is not None:
            path = Path(temporary) / "values.json"
            path.write_text(json.dumps(values))
            command += ["-f", str(path)]
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode:
            raise ValueError(result.stderr)
        parsed = subprocess.run(
            ["ruby", "-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.load_stream(STDIN.read).compact)"],
            input=result.stdout, capture_output=True, text=True, check=True,
        )
        return json.loads(parsed.stdout)


class ChartContracts(unittest.TestCase):
    def test_disabled_chart_is_empty(self):
        self.assertEqual(render(), [])

    def test_clickhouse_and_membership_flags_are_independent(self):
        only_ch = fixture()
        only_ch["membershipEnabled"] = False
        objects = render(only_ch)
        self.assertEqual([obj["metadata"]["labels"].get("greenguard.io/acceptance-probe")
                          for obj in objects if obj["kind"] == "Job"], ["clickhouse-roundtrip"])
        only_membership = fixture()
        only_membership["clickhouseEnabled"] = False
        objects = render(only_membership)
        self.assertEqual([obj["metadata"]["labels"].get("greenguard.io/acceptance-probe")
                          for obj in objects if obj["kind"] == "Job"], ["tenant-membership-readback"])

    def test_enabled_chart_requires_disposable_scope_and_pinned_images(self):
        for field, value in (
            ("namespace", "default"), ("cell", "../other"), ("revision", "main"),
            ("clickhouseImage", "clickhouse/clickhouse-server:latest"),
            ("tenantControlPlaneImage", "ghcr.io/pahuldeepp/grainguard/tenant-control-plane:latest"),
            ("clickhouseSecret", "shared-secret"), ("identitySecret", "demo-users"),
            ("membershipAudience", ""), ("accessTokenSecret", "dex-admin-password"),
        ):
            values = fixture()
            values[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                render(values)
        with self.assertRaises(ValueError):
            render(fixture(), namespace="other")

    def test_jobs_use_scoped_secrets_and_real_roundtrip_assertions(self):
        objects = render(fixture())
        jobs = {obj["metadata"]["labels"].get("greenguard.io/acceptance-probe"): obj
                for obj in objects if obj["kind"] == "Job"}
        self.assertEqual(set(jobs), {"clickhouse-roundtrip", "tenant-membership-readback"})
        clickhouse = jobs["clickhouse-roundtrip"]
        ch_container = clickhouse["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(ch_container["image"], fixture()["clickhouseImage"])
        self.assertIn("/probe/clickhouse-roundtrip.sh", ch_container["args"][0])
        self.assertEqual(ch_container["env"][1]["valueFrom"]["secretKeyRef"], {
            "name": "greenguard-telemetry-clickhouse-config", "key": "CLICKHOUSE_PASSWORD"})

        membership = jobs["tenant-membership-readback"]
        cp_container = membership["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(cp_container["image"], fixture()["tenantControlPlaneImage"])
        env = {item["name"]: item for item in cp_container["env"]}
        self.assertEqual(env["CONTROL_LOOKUP_TOKEN"]["valueFrom"]["secretKeyRef"], {
            "name": "tenant-control-plane-config", "key": "CONTROL_LOOKUP_TOKEN"})
        self.assertEqual(env["DEX_ISSUER"]["valueFrom"]["secretKeyRef"], {
            "name": "greenguard-dex-config", "key": "DEX_ISSUER"})
        self.assertEqual(env["MEMBERSHIP_AUDIENCE"]["value"], "greenguard-dashboard")
        self.assertEqual(env["GREENGUARD_ACCESS_TOKEN"]["valueFrom"]["secretKeyRef"], {
            "name": "greenguard-acceptance-oidc-token", "key": "access-token"})
        self.assertFalse(membership["spec"]["template"]["spec"]["automountServiceAccountToken"])
        rendered = json.dumps(objects)
        self.assertNotIn("DEX_FIRST_ADMIN_USER_ID", rendered)
        self.assertNotIn("DEX_FIRST_ADMIN_PASSWORD_HASH", rendered)

        source = next(obj for obj in objects if obj["kind"] == "ConfigMap")
        sql = source["data"]["clickhouse-roundtrip.sh"]
        self.assertIn("CREATE TEMPORARY TABLE", sql)
        self.assertIn("INSERT INTO", sql)
        self.assertIn("DROP TEMPORARY TABLE", sql)
        script = source["data"]["tenant-membership-readback.mjs"]
        self.assertIn("verifySignature", script)
        self.assertIn("claims.sub", script)
        self.assertNotIn("console.log(token", script)

    def test_disabled_probe_does_not_install_its_network_policies(self):
        values = fixture()
        values["membershipEnabled"] = False
        objects = render(values)
        names = {obj["metadata"]["name"] for obj in objects if obj["kind"] == "NetworkPolicy"}
        self.assertEqual(names, {"greenguard-live-acceptance-egress", "greenguard-clickhouse-acceptance-ingress", "acceptance-clickhouse-roundtrip-egress"})

    def test_policies_are_narrow_and_membership_rule_is_get_only(self):
        objects = render(fixture())
        egress = next(obj for obj in objects if obj["kind"] == "NetworkPolicy"
                      and obj["metadata"]["name"] == "greenguard-live-acceptance-egress")
        self.assertEqual(len(egress["spec"]["egress"]), 2)
        auth = next(obj for obj in objects if obj["kind"] == "AuthorizationPolicy" and obj["metadata"]["name"] == "tenant-control-plane-acceptance-readback")
        self.assertEqual(auth["spec"]["rules"][0]["to"][0]["operation"], {
            "methods": ["GET"], "paths": ["/v1/internal/memberships"]})


class MembershipProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tls_directory = tempfile.TemporaryDirectory(prefix="gg-jwks-test-")
        cls.addClassCleanup(cls.tls_directory.cleanup)
        cls.key_file = Path(cls.tls_directory.name) / "key.pem"
        cls.cert_file = Path(cls.tls_directory.name) / "cert.pem"
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
            "-keyout", str(cls.key_file), "-out", str(cls.cert_file),
        ], capture_output=True, check=True)

    def make_token(self, issuer, *, subject="actual-token-sub", audience="greenguard-dashboard", exp=None,
                   header_overrides=None, modulus_length=2048):
        payload = {"iss": issuer, "sub": subject, "aud": audience,
                   "exp": exp if exp is not None else int(time.time()) + 600,
                   "iat": int(time.time())}
        signer = '''const c=require("crypto");
const payload=JSON.parse(process.argv[1]);
const pair=c.generateKeyPairSync("rsa",{modulusLength:Number(process.argv[2])});
const enc=(x)=>Buffer.from(JSON.stringify(x)).toString("base64url");
const h=enc({...{alg:"RS256",typ:"JWT",kid:"acceptance-test-key"},...JSON.parse(process.argv[3])});
const p=enc(payload);const input=`${h}.${p}`;
const signature=c.sign("RSA-SHA256",Buffer.from(input),pair.privateKey).toString("base64url");
const jwk=pair.publicKey.export({format:"jwk"});
console.log(JSON.stringify({token:`${input}.${signature}`,jwk:{...jwk,kid:"acceptance-test-key",use:"sig",alg:"RS256"}}));'''
        result = subprocess.run(["node", "-e", signer, json.dumps(payload), str(modulus_length),
                                 json.dumps(header_overrides or {})], capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    def start_fixture_server(self, issuer_key):
        state = {"jwk": issuer_key, "membership_subject": "actual-token-sub", "status": 200, "lookup": None}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/dex/keys":
                    body = json.dumps({"keys": [state["jwk"]]}).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(body)
                    return
                parsed = urlsplit(self.path)
                query = parse_qs(parsed.query)
                state["lookup"] = {"issuer": query.get("issuer", [None])[0],
                                    "subject": query.get("subject", [None])[0],
                                    "auth": self.headers.get("Authorization")}
                status = state["status"] if state["status"] != 200 else (200 if state["lookup"]["subject"] == state["membership_subject"] else 404)
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                if status == 200:
                    body = {"tenantId": "123e4567-e89b-42d3-a456-426614174000",
                            "roles": ["admin"], "version": "1", "state": "active"}
                    self.wfile.write(json.dumps(body).encode())
                else:
                    self.wfile.write(b"private response detail")

            def log_message(self, *_args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.cert_file, self.key_file)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.shutdown)
        base = f"https://localhost:{server.server_port}"
        return server, state, base

    def execute_probe(self, issuer, access_token, audience="greenguard-dashboard", base="https://localhost:4443"):
        env = {
            **os.environ,
            "NODE_EXTRA_CA_CERTS": str(self.cert_file),
            "DEX_ISSUER": issuer,
            "MEMBERSHIP_AUDIENCE": audience,
            "GREENGUARD_ACCESS_TOKEN": access_token,
            "CONTROL_LOOKUP_TOKEN": "test-secret-token-never-print",
            "MEMBERSHIP_LOOKUP_URL": base + "/membership",
        }
        return subprocess.run(["node", str(PROBE)], env=env, capture_output=True, text=True)

    def test_verified_access_token_subject_is_used_for_active_admin_readback(self):
        # The identity subject is deliberately different from Dex staticPasswords.userID.
        server, state, base = self.start_fixture_server({})
        issuer = base + "/dex"
        signed = self.make_token(issuer, subject="actual-token-sub")
        state["jwk"] = signed["jwk"]
        result = self.execute_probe(issuer, signed["token"], base=base)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("PASS tenant-membership-readback", result.stdout)
        self.assertEqual(state["lookup"]["issuer"], issuer)
        self.assertEqual(state["lookup"]["subject"], "actual-token-sub")
        self.assertEqual(state["lookup"]["auth"], "Bearer test-secret-token-never-print")
        self.assertNotIn("test-secret-token-never-print", result.stdout + result.stderr)
        self.assertNotIn("actual-token-sub", result.stdout + result.stderr)

    def test_wrong_subject_fails_when_verified_subject_has_no_membership(self):
        server, state, base = self.start_fixture_server({})
        issuer = base + "/dex"
        signed = self.make_token(issuer, subject="different-verified-sub")
        state["jwk"] = signed["jwk"]
        state["membership_subject"] = "expected-admin-sub"
        result = self.execute_probe(issuer, signed["token"], base=base)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(state["lookup"]["subject"], "different-verified-sub")
        self.assertIn("HTTP 404", result.stderr)
        self.assertNotIn("different-verified-sub", result.stdout + result.stderr)

    def test_wrong_issuer_audience_expiry_and_jwks_signature_fail_closed(self):
        for field, token_issuer, audience, exp in (
            ("issuer", "https://wrong-issuer.example/dex", "greenguard-dashboard", None),
            ("audience", None, "other-api", None),
            ("expiry", None, "greenguard-dashboard", 1),
        ):
            with self.subTest(field=field):
                server, state, base = self.start_fixture_server({})
                issuer = base + "/dex"
                signed = self.make_token(token_issuer or issuer, audience=audience, exp=exp)
                state["jwk"] = signed["jwk"]
                result = self.execute_probe(issuer, signed["token"], audience="greenguard-dashboard", base=base)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("issuer, audience, lifetime or subject is invalid", result.stderr)
                self.assertIsNone(state["lookup"])

        server, state, base = self.start_fixture_server({})
        issuer = base + "/dex"
        signed = self.make_token(issuer)
        unrelated = self.make_token(issuer)
        state["jwk"] = unrelated["jwk"]
        result = self.execute_probe(issuer, signed["token"], base=base)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("signature does not match", result.stderr)
        self.assertIsNone(state["lookup"])

    def test_plain_http_issuer_is_rejected_before_membership_call(self):
        server, state, base = self.start_fixture_server({})
        signed = self.make_token("http://issuer.example/dex")
        state["jwk"] = signed["jwk"]
        result = self.execute_probe("http://issuer.example/dex", signed["token"], base=base)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be an HTTPS URL", result.stderr)
        self.assertIsNone(state["lookup"])

    def test_unsupported_critical_header_and_weak_rsa_key_fail_closed(self):
        cases = (
            ("critical-header", {"crit": ["unknown"]}, 2048,
             "unsupported JOSE header parameters"),
            ("weak-key", {}, 1024, "below the minimum strength"),
        )
        for name, header, modulus_length, expected_error in cases:
            with self.subTest(case=name):
                server, state, base = self.start_fixture_server({})
                issuer = base + "/dex"
                signed = self.make_token(issuer, header_overrides=header, modulus_length=modulus_length)
                state["jwk"] = signed["jwk"]
                result = self.execute_probe(issuer, signed["token"], base=base)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected_error, result.stderr)
                self.assertIsNone(state["lookup"])


if __name__ == "__main__":
    unittest.main()
