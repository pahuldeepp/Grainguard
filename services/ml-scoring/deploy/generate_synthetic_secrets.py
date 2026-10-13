#!/usr/bin/env python3
"""Generate short-lived credentials and TLS files for the isolated ML sandbox.

Files are created with owner-only permissions. Secret values are never printed.
This is a disposable developer bootstrap helper, not production PKI/rotation.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile


KAFKA_NAMESPACE = "ml-synthetic"
KAFKA_ADMIN = "ml_synthetic_admin"
KAFKA_SCORER = "ml_scoring"
KAFKA_FIXTURE = "ml_fixture"
POSTGRES_HOST = "postgres.ml-synthetic.svc.cluster.local"
KAFKA_HOSTS = (
    "kafka.ml-synthetic.svc.cluster.local",
    "ml-synthetic-kafka-0.kafka-headless.ml-synthetic.svc.cluster.local",
)


def run(command: list[str], *, cwd: Path) -> None:
    result = subprocess.run(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError(f"certificate generation failed ({Path(command[0]).name})")


def write_secret_file(directory: Path, name: str, content: bytes) -> None:
    path = directory / name
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(content)


def make_certificate(
    work: Path,
    *,
    common_name: str,
    sans: tuple[str, ...],
    ca_key: Path,
    ca_cert: Path,
    stem: str,
) -> tuple[Path, Path]:
    key, csr, cert, ext = (work / f"{stem}.{suffix}" for suffix in ("key", "csr", "crt", "ext"))
    ext.write_text(
        "basicConstraints=critical,CA:FALSE\n"
        "keyUsage=critical,digitalSignature,keyEncipherment\n"
        "extendedKeyUsage=serverAuth,clientAuth\n"
        "subjectAltName=" + ",".join(f"DNS:{name}" for name in sans) + "\n",
        encoding="ascii",
    )
    os.chmod(ext, 0o600)
    run([
        "openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes",
        "-subj", f"/CN={common_name}", "-keyout", str(key), "-out", str(csr),
    ], cwd=work)
    os.chmod(key, 0o600)
    run([
        "openssl", "x509", "-req", "-in", str(csr), "-CA", str(ca_cert),
        "-CAkey", str(ca_key), "-CAcreateserial", "-days", "30", "-sha256",
        "-extfile", str(ext), "-out", str(cert),
    ], cwd=work)
    return key, cert


def generate(output: Path) -> None:
    if not shutil.which("openssl") or not shutil.which("keytool"):
        raise RuntimeError("openssl and keytool are required")
    output = output.expanduser()
    if output.exists():
        if output.is_symlink() or not output.is_dir() or any(output.iterdir()):
            raise RuntimeError("output path must be a new or empty real directory")
    else:
        output.mkdir(mode=0o700, parents=True)
    os.chmod(output, 0o700)
    if output.stat().st_mode & 0o077:
        raise RuntimeError("output directory must be owner-only")

    pg_auth = output / "ml-synthetic-postgres-auth"
    kafka_auth = output / "ml-synthetic-kafka-auth"
    kafka_tls = output / "ml-synthetic-kafka-tls"
    runtime = output / "ml-scoring-runtime"
    migrator = output / "ml-scoring-migrator"
    fixture = output / "ml-scoring-fixture"
    for directory in (pg_auth, kafka_auth, kafka_tls, runtime, migrator, fixture):
        directory.mkdir(mode=0o700)

    pg_bootstrap_password = secrets.token_hex(32)
    pg_migration_password = secrets.token_hex(32)
    pg_runtime_password = secrets.token_hex(32)
    kafka_admin_password = secrets.token_hex(32)
    kafka_scorer_password = secrets.token_hex(32)
    kafka_fixture_password = secrets.token_hex(32)
    keystore_password = secrets.token_hex(24)
    truststore_password = secrets.token_hex(24)

    with tempfile.TemporaryDirectory(prefix="gg-ml-pki-", dir=output) as temporary:
        work = Path(temporary)
        ca_key, ca_cert = work / "ca.key", work / "ca.crt"
        run([
            "openssl", "req", "-x509", "-newkey", "rsa:3072", "-nodes",
            "-days", "30", "-sha256", "-subj", "/CN=GreenGuard ML Synthetic CA",
            "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
            "-addext", "keyUsage=critical,keyCertSign,cRLSign",
            "-keyout", str(ca_key), "-out", str(ca_cert),
        ], cwd=work)
        os.chmod(ca_key, 0o600)
        pg_key, pg_cert = make_certificate(
            work, common_name=POSTGRES_HOST, sans=(POSTGRES_HOST,),
            ca_key=ca_key, ca_cert=ca_cert, stem="postgres",
        )
        kafka_key, kafka_cert = make_certificate(
            work, common_name=KAFKA_HOSTS[0], sans=KAFKA_HOSTS,
            ca_key=ca_key, ca_cert=ca_cert, stem="kafka",
        )
        keystore = work / "broker.keystore.p12"
        truststore = work / "broker.truststore.p12"
        run([
            "openssl", "pkcs12", "-export", "-name", "ml-synthetic-broker",
            "-inkey", str(kafka_key), "-in", str(kafka_cert), "-certfile", str(ca_cert),
            "-out", str(keystore), "-passout", f"pass:{keystore_password}",
        ], cwd=work)
        run([
            "keytool", "-importcert", "-noprompt", "-storetype", "PKCS12",
            "-alias", "greenguard-ml-synthetic-ca", "-file", str(ca_cert),
            "-keystore", str(truststore), "-storepass", truststore_password,
        ], cwd=work)

        write_secret_file(pg_auth, "bootstrap-password", pg_bootstrap_password.encode())
        write_secret_file(pg_auth, "migrator-password", pg_migration_password.encode())
        write_secret_file(pg_auth, "runtime-password", pg_runtime_password.encode())
        write_secret_file(pg_auth, "server.crt", pg_cert.read_bytes())
        write_secret_file(pg_auth, "server.key", pg_key.read_bytes())
        write_secret_file(pg_auth, "ca.crt", ca_cert.read_bytes())

        write_secret_file(kafka_auth, "admin-password", kafka_admin_password.encode())
        write_secret_file(kafka_auth, "scorer-password", kafka_scorer_password.encode())
        write_secret_file(kafka_auth, "fixture-password", kafka_fixture_password.encode())
        write_secret_file(
            kafka_auth, "broker-jaas",
            b"KafkaServer { org.apache.kafka.common.security.scram.ScramLoginModule required; };\n",
        )
        write_secret_file(
            kafka_auth, "inter-broker-jaas",
            ("org.apache.kafka.common.security.scram.ScramLoginModule required "
             f'username="{KAFKA_ADMIN}" password="{kafka_admin_password}";').encode(),
        )
        write_secret_file(kafka_tls, "broker.keystore.p12", keystore.read_bytes())
        write_secret_file(kafka_tls, "broker.truststore.p12", truststore.read_bytes())
        write_secret_file(kafka_tls, "keystore-password", keystore_password.encode())
        write_secret_file(kafka_tls, "key-password", keystore_password.encode())
        write_secret_file(kafka_tls, "truststore-password", truststore_password.encode())
        write_secret_file(kafka_tls, "ca.crt", ca_cert.read_bytes())

    runtime_dsn = (
        f"postgresql://ml_app:{pg_runtime_password}@{POSTGRES_HOST}:5432/greenguard_ml"
        "?sslmode=verify-full&sslrootcert=/var/run/postgres-tls/root.crt"
    )
    migration_dsn = (
        f"postgresql://ml_migrator:{pg_migration_password}@{POSTGRES_HOST}:5432/greenguard_ml"
        "?sslmode=verify-full&sslrootcert=/var/run/postgres-tls/root.crt"
    )
    write_secret_file(runtime, "database-url", runtime_dsn.encode())
    write_secret_file(runtime, "kafka-username", KAFKA_SCORER.encode())
    write_secret_file(runtime, "kafka-password", kafka_scorer_password.encode())
    write_secret_file(runtime, "operations-token", secrets.token_urlsafe(48).encode())
    write_secret_file(migrator, "database-url", migration_dsn.encode())
    write_secret_file(fixture, "kafka-username", KAFKA_FIXTURE.encode())
    write_secret_file(fixture, "kafka-password", kafka_fixture_password.encode())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True, type=Path)
    arguments = parser.parse_args()
    try:
        generate(arguments.output_dir)
    except (OSError, RuntimeError, ValueError) as exc:
        raise SystemExit(f"secret generation failed: {exc}") from exc
    print(
        f"Generated disposable synthetic credential files under {arguments.output_dir}; "
        "values were not printed. Protect, use, and delete the directory after the test."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
