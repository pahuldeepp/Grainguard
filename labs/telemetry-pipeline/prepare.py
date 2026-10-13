#!/usr/bin/env python3
"""Create disposable SASL_SSL credentials for the local telemetry sink lab."""

from __future__ import annotations

import os
from pathlib import Path
import secrets
import shutil
import subprocess


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / ".local/telemetry-pipeline/kafka"
ENV = ROOT / ".local/telemetry-pipeline.env"


def run(*args: str) -> None:
    try:
        subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        raise RuntimeError(f"local TLS setup failed in {args[0]}") from None


def main() -> None:
    shutil.rmtree(OUT.parent, ignore_errors=True)
    OUT.mkdir(parents=True, exist_ok=True)
    os.chmod(OUT.parent, 0o700)
    ca_key, ca_cert = OUT / "ca.key", OUT / "ca.crt"
    server_key, server_csr = OUT / "kafka.key", OUT / "kafka.csr"
    server_cert, ext = OUT / "kafka.crt", OUT / "kafka.ext"
    keystore, truststore = OUT / "server.p12", OUT / "truststore.p12"
    password = secrets.token_urlsafe(24)

    run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
        "-subj", "/CN=GreenGuard Local Telemetry Test CA", "-keyout", str(ca_key), "-out", str(ca_cert))
    run("openssl", "req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=kafka",
        "-keyout", str(server_key), "-out", str(server_csr))
    ext.write_text("subjectAltName=DNS:kafka\nextendedKeyUsage=serverAuth\n", encoding="ascii")
    run("openssl", "x509", "-req", "-in", str(server_csr), "-CA", str(ca_cert), "-CAkey", str(ca_key),
        "-CAcreateserial", "-days", "2", "-extfile", str(ext), "-out", str(server_cert))
    run("openssl", "pkcs12", "-export", "-in", str(server_cert), "-inkey", str(server_key),
        "-certfile", str(ca_cert), "-name", "kafka", "-out", str(keystore), "-passout", f"pass:{password}")
    run("keytool", "-importcert", "-noprompt", "-alias", "greenguard-test-ca", "-file", str(ca_cert),
        "-keystore", str(truststore), "-storetype", "PKCS12", "-storepass", password)

    users = {name: secrets.token_urlsafe(24) for name in ("broker", "publisher", "replay", "archive", "clickhouse")}
    jaas = "org.apache.kafka.common.security.plain.PlainLoginModule required " + \
        f'username="broker" password="{users["broker"]}" ' + \
        " ".join(f'user_{name}="{secret}"' for name, secret in users.items()) + ";"
    values = {
        "KAFKA_BROKER_JAAS": jaas,
        "KAFKA_KEYSTORE_PASSWORD": password,
        "KAFKA_TRUSTSTORE_PASSWORD": password,
        "KAFKA_PUBLISHER_PASSWORD": users["publisher"],
        "KAFKA_REPLAY_PASSWORD": users["replay"],
        "KAFKA_ARCHIVE_PASSWORD": users["archive"],
        "KAFKA_CLICKHOUSE_PASSWORD": users["clickhouse"],
        "MINIO_USER": "ggtelemetry",
        "MINIO_PASSWORD": secrets.token_urlsafe(32),
        "CLICKHOUSE_PASSWORD": secrets.token_urlsafe(32),
        "TELEMETRY_ARCHIVE_BUCKET": "greenguard-telemetry-test",
    }
    ENV.write_text("".join(f"{name}='{value}'\n" for name, value in values.items()), encoding="utf-8")
    os.chmod(ENV, 0o600)

    for name in ("publisher", "replay", "archive", "clickhouse", "broker"):
        props = OUT / f"{name}.properties"
        props.write_text(
            "security.protocol=SASL_SSL\n"
            "sasl.mechanism=PLAIN\n"
            f'sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required username="{name}" password="{users[name]}";\n'
            "ssl.truststore.type=PKCS12\n"
            "ssl.truststore.location=/run/kafka/truststore.p12\n"
            f"ssl.truststore.password={password}\n"
            "ssl.endpoint.identification.algorithm=HTTPS\n"
            "request.timeout.ms=120000\n",
            encoding="utf-8",
        )
        os.chmod(props, 0o600)
    for path in OUT.iterdir():
        if path.is_file():
            os.chmod(path, 0o600)
    # The CA certificate is public. Containers read it as a different non-root user than
    # the host runner, so it must be world-readable (private keys stay 0600).
    os.chmod(ca_cert, 0o644)
    print("Prepared temporary local SASL_SSL credentials and certificates in ignored .local/.")


if __name__ == "__main__":
    main()
