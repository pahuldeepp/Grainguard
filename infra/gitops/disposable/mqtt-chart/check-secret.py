#!/usr/bin/env python3
"""Fail-closed, offline validation of the MQTT broker Secret and exact topic ACL."""

import argparse
import base64
import binascii
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path


KEYS = {"tls.crt", "tls.key", "ca.crt", "passwords", "acl"}
NAME = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$")
PRINCIPAL = re.compile(r"^[A-Za-z0-9_-]+$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
HASH = re.compile(r"^\$7\$[A-Za-z0-9$./+_=-]{20,}$")


class Invalid(Exception):
    pass


def command(*args, input_bytes=None):
    result = subprocess.run(
        ["openssl", *args], input=input_bytes, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, check=False,
    )
    if result.returncode:
        raise Invalid("TLS certificate, key, or CA is invalid")
    return result.stdout


def check_tls(data, hosts):
    with tempfile.TemporaryDirectory(prefix="greenguard-mqtt-secret-") as directory:
        files = {}
        for key in ("tls.crt", "tls.key", "ca.crt"):
            path = Path(directory) / key
            path.write_bytes(data[key])
            path.chmod(0o600)
            files[key] = path
        for host in hosts:
            command("verify", "-CAfile", str(files["ca.crt"]), "-verify_hostname", host, str(files["tls.crt"]))
        certificate_key = command("x509", "-in", str(files["tls.crt"]), "-pubkey", "-noout")
        certificate_der = command("pkey", "-pubin", "-outform", "DER", input_bytes=certificate_key)
        private_der = command("pkey", "-in", str(files["tls.key"]), "-pubout", "-outform", "DER")
        if certificate_der != private_der:
            raise Invalid("TLS private key does not match certificate")


def load_inventory(path):
    try:
        inventory = json.loads(Path(path).read_text())
    except (OSError, ValueError) as exc:
        raise Invalid("device inventory is missing or malformed") from exc
    if not isinstance(inventory, dict) or set(inventory) != {"devices"} or not isinstance(inventory["devices"], list):
        raise Invalid("device inventory must contain only a devices array")
    devices = {}
    for item in inventory["devices"]:
        if not isinstance(item, dict) or set(item) != {"username", "tenant_id", "asset_id"}:
            raise Invalid("device inventory entry must have username, tenant_id, and asset_id")
        username, tenant, asset = item["username"], item["tenant_id"], item["asset_id"]
        if not all(isinstance(x, str) for x in (username, tenant, asset)) or not PRINCIPAL.fullmatch(username) or not UUID.fullmatch(tenant) or not UUID.fullmatch(asset):
            raise Invalid("device inventory contains an invalid principal or topic identity")
        if username in devices:
            raise Invalid("device inventory has duplicate principals")
        devices[username] = (tenant, asset)
    return devices


def check_principals(data, devices, worker):
    if not PRINCIPAL.fullmatch(worker) or worker in devices:
        raise Invalid("worker principal conflicts with a device")
    expected = {worker: {
        "topic write greenguard/+/+/command",
        "topic read greenguard/+/+/ack",
    }}
    for username, (tenant, asset) in devices.items():
        expected[username] = {
            f"topic read greenguard/{tenant}/{asset}/command",
            f"topic write greenguard/{tenant}/{asset}/ack",
        }
    try:
        password_lines = data["passwords"].decode("utf-8").splitlines()
        acl_lines = data["acl"].decode("utf-8").splitlines()
    except UnicodeDecodeError as exc:
        raise Invalid("passwords and ACL must be UTF-8 text") from exc
    users = {}
    for line in password_lines:
        if not line or ":" not in line:
            raise Invalid("password file contains a blank or malformed entry")
        name, hashed = line.split(":", 1)
        if not PRINCIPAL.fullmatch(name) or not HASH.fullmatch(hashed) or name in users:
            raise Invalid("password file contains an invalid, duplicate, or plaintext entry")
        users[name] = hashed
    if set(users) != set(expected):
        raise Invalid("password principals do not match the device inventory and worker")
    actual = {}
    current = None
    for line in acl_lines:
        if line.startswith("user "):
            current = line[5:]
            if current not in expected or current in actual:
                raise Invalid("ACL has an unknown or duplicate principal")
            actual[current] = set()
        elif current is None or line not in expected[current] or line in actual[current]:
            raise Invalid("ACL contains an extra or overbroad topic grant")
        else:
            actual[current].add(line)
    if actual != expected:
        raise Invalid("ACL does not exactly match required per-principal grants")


def validate(secret_path, inventory_path, namespace, secret_name, worker, external_hostname=None):
    if not NAME.fullmatch(namespace) or not NAME.fullmatch(secret_name):
        raise Invalid("namespace or Secret name is invalid")
    try:
        secret = json.loads(Path(secret_path).read_text())
    except (OSError, ValueError) as exc:
        raise Invalid("Secret JSON is missing or malformed") from exc
    if not isinstance(secret, dict) or secret.get("kind") != "Secret" or secret.get("type") != "Opaque":
        raise Invalid("input must be an Opaque Kubernetes Secret")
    meta = secret.get("metadata", {})
    if not isinstance(meta, dict) or meta.get("name") != secret_name or meta.get("namespace") != namespace:
        raise Invalid("Secret name or namespace does not match the intended broker")
    encoded = secret.get("data")
    if not isinstance(encoded, dict) or set(encoded) != KEYS:
        raise Invalid("Secret data must contain exactly the broker TLS and authentication keys")
    try:
        data = {key: base64.b64decode(encoded[key], validate=True) for key in KEYS}
    except (TypeError, ValueError, binascii.Error) as exc:
        raise Invalid("Secret data has invalid base64") from exc
    if any(not value or len(value) > 1024 * 1024 for value in data.values()):
        raise Invalid("Secret data is empty or exceeds the size bound")
    devices = load_inventory(inventory_path)
    hosts = [f"mqtt.{namespace}.svc.cluster.local"]
    if external_hostname:
        if not re.fullmatch(r"[a-z0-9]([a-z0-9.-]*[a-z0-9])?", external_hostname) or "." not in external_hostname or external_hostname.endswith(".svc.cluster.local"):
            raise Invalid("external hostname must be a public DNS name")
        hosts.append(external_hostname)
    check_tls(data, hosts)
    check_principals(data, devices, worker)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--secret-json", required=True)
    parser.add_argument("--devices-json", required=True)
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--secret-name", default="greenguard-mqtt-broker")
    parser.add_argument("--worker-username", default="greenguard-hardware-worker")
    parser.add_argument("--external-hostname", help="also require this public hostname in the broker certificate")
    args = parser.parse_args()
    try:
        validate(args.secret_json, args.devices_json, args.namespace, args.secret_name, args.worker_username, args.external_hostname)
    except Invalid as exc:
        print(f"MQTT Secret validation failed: {exc}", file=sys.stderr)
        return 1
    print("MQTT Secret TLS, password hashes, and exact ACL verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
