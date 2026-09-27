import base64
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


HERE = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("mqtt_check_secret", HERE / "check-secret.py")
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)
TENANT = "11111111-1111-4111-8111-111111111111"
ASSET = "22222222-2222-4222-8222-222222222222"


def openssl(*args):
    subprocess.run(["openssl", *args], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)


class MQTTSecretTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        root = self.path / "root"
        server = self.path / "server"
        openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=MQTT test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", str(root) + ".key", "-out", str(root) + ".crt")
        openssl("req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=mqtt.greenguard-data.svc.cluster.local", "-addext", "subjectAltName=DNS:mqtt.greenguard-data.svc.cluster.local", "-keyout", str(server) + ".key", "-out", str(server) + ".csr")
        (self.path / "ext.cnf").write_text("subjectAltName=DNS:mqtt.greenguard-data.svc.cluster.local,DNS:sensors.example.org\n")
        openssl("x509", "-req", "-in", str(server) + ".csr", "-CA", str(root) + ".crt", "-CAkey", str(root) + ".key", "-CAcreateserial", "-days", "2", "-extfile", str(self.path / "ext.cnf"), "-out", str(server) + ".crt")
        self.data = {
            "tls.crt": Path(str(server) + ".crt").read_bytes(),
            "tls.key": Path(str(server) + ".key").read_bytes(),
            "ca.crt": Path(str(root) + ".crt").read_bytes(),
            "passwords": b"greenguard-hardware-worker:$7$101$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsensor1:$7$101$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
            "acl": f"user greenguard-hardware-worker\ntopic write greenguard/+/+/command\ntopic read greenguard/+/+/ack\nuser sensor1\ntopic read greenguard/{TENANT}/{ASSET}/command\ntopic write greenguard/{TENANT}/{ASSET}/ack\n".encode(),
        }
        (self.path / "devices.json").write_text(json.dumps({"devices": [{"username": "sensor1", "tenant_id": TENANT, "asset_id": ASSET}]}))

    def validate(self, data=None, namespace="greenguard-data", external_hostname=None):
        encoded = {name: base64.b64encode(value).decode() for name, value in (data or self.data).items()}
        (self.path / "secret.json").write_text(json.dumps({"kind": "Secret", "type": "Opaque", "metadata": {"name": "greenguard-mqtt-broker", "namespace": "greenguard-data"}, "data": encoded}))
        CHECK.validate(self.path / "secret.json", self.path / "devices.json", namespace, "greenguard-mqtt-broker", "greenguard-hardware-worker", external_hostname)

    def test_valid_exact_secret(self):
        self.validate()

    def test_valid_external_hostname(self):
        self.validate(external_hostname="sensors.example.org")

    def test_rejects_unlisted_external_hostname(self):
        with self.assertRaises(CHECK.Invalid):
            self.validate(external_hostname="other.example.org")

    def test_rejects_wrong_hostname(self):
        with self.assertRaises(CHECK.Invalid):
            self.validate(namespace="other")

    def test_rejects_plaintext_password(self):
        with self.assertRaises(CHECK.Invalid):
            self.validate({**self.data, "passwords": self.data["passwords"].replace(b"$7$101$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", b"plaintext")})

    def test_rejects_extra_device_topic(self):
        with self.assertRaises(CHECK.Invalid):
            self.validate({**self.data, "acl": self.data["acl"] + b"topic read greenguard/#\n"})

    def test_rejects_missing_tls_key(self):
        with self.assertRaises(CHECK.Invalid):
            self.validate({name: value for name, value in self.data.items() if name != "tls.key"})

    def test_rejects_wrong_key(self):
        with self.assertRaises(CHECK.Invalid):
            self.validate({**self.data, "tls.key": (self.path / "root.key").read_bytes()})


if __name__ == "__main__":
    unittest.main()
