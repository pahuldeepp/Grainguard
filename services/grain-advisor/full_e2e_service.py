"""Disposable local Advisor HTTP service used by the joined Dex/MCP acceptance."""
from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from uuid import uuid4

import psycopg
from psycopg import sql
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from advisor_security.receiver import configured_server
from agent_workflow import postgres_checkpointer
from migrate_security import apply as apply_migration

ROOT = Path(__file__).resolve().parents[2]
KNOWLEDGE_ROOT = ROOT / "services" / "knowledge-service"
sys.path.insert(0, str(KNOWLEDGE_ROOT))
sys.path.insert(0, str(KNOWLEDGE_ROOT / "tests"))
from knowledge_extensions.http_api import create_server as create_knowledge_server
from knowledge_extensions.membership_provisioning import provision
from knowledge_extensions.oidc_auth import (
    CompositeOidcAuthenticator,
    OidcAuthenticator,
    PostgresMemberships,
)
from knowledge_extensions.service import KnowledgeRagService
from local_rag_adapters import LocalAnswerGenerator, LocalEmbedding, LocalReranker, LocalVectorStore
from pdf_fixture import make_text_pdf


IMAGE = "postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea"
stop = threading.Event()


def pem_server(directory: Path):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = datetime.now(timezone.utc)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=1))
            .not_valid_after(now + timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), False)
            .sign(key, hashes.SHA256()))
    cert_path, key_path = directory / "jwks-cert.pem", directory / "jwks-key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    os.chmod(key_path, 0o600)
    os.environ["SSL_CERT_FILE"] = str(cert_path)
    return cert_path, key_path


def main():
    container = "greenguard-advisor-full-e2e-" + str(uuid4())[:8]
    password = uuid4().hex
    checkpoint_password = uuid4().hex
    knowledge_app_password = uuid4().hex
    knowledge_provisioner_password = uuid4().hex
    knowledge_reviewer_password = uuid4().hex

    def docker(*args):
        return subprocess.check_output(["docker", *args], text=True,
            stderr=subprocess.DEVNULL).strip()

    advisor_http = None
    knowledge_http = None
    tls_http = None
    server_thread = None
    knowledge_thread = None
    tls_thread = None
    work = tempfile.TemporaryDirectory(prefix="greenguard-advisor-e2e-")
    try:
        docker("run", "-d", "--name", container, "-e", "POSTGRES_USER=advisor_migrator",
            "-e", "POSTGRES_PASSWORD=" + password, "-e", "POSTGRES_DB=greenguard_advisor",
            "-p", "127.0.0.1::5432", IMAGE)
        port = docker("port", container, "5432/tcp").rsplit(":", 1)[1]
        admin = f"postgresql://advisor_migrator:{password}@127.0.0.1:{port}/greenguard_advisor"
        app = f"postgresql://advisor_app:{password}@127.0.0.1:{port}/greenguard_advisor"
        checkpoint = f"postgresql://advisor_checkpoint:{checkpoint_password}@127.0.0.1:{port}/greenguard_advisor"
        for _ in range(60):
            try:
                with psycopg.connect(admin, connect_timeout=1):
                    break
            except psycopg.OperationalError:
                time.sleep(.25)
        else:
            raise RuntimeError("Advisor E2E PostgreSQL did not become ready")
        with psycopg.connect(admin) as db:
            db.execute(sql.SQL("CREATE ROLE advisor_app LOGIN PASSWORD {} NOBYPASSRLS")
                       .format(sql.Literal(password)))
            db.execute(sql.SQL("CREATE ROLE advisor_checkpoint LOGIN PASSWORD {} NOBYPASSRLS")
                       .format(sql.Literal(checkpoint_password)))
            apply_migration(db)
        with postgres_checkpointer(admin, setup=True):
            pass
        with psycopg.connect(admin) as db:
            db.execute("GRANT USAGE ON SCHEMA public TO advisor_checkpoint")
            for table in ("checkpoints", "checkpoint_blobs", "checkpoint_writes"):
                db.execute(sql.SQL("GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.{} TO advisor_checkpoint")
                           .format(sql.Identifier(table)))
            db.execute("GRANT SELECT ON TABLE public.checkpoint_migrations TO advisor_checkpoint")

        # Keep actual local RAG data/migrations separate from Advisor while
        # using the same disposable Postgres server for a joined service E2E.
        knowledge_admin = admin.rsplit("/", 1)[0] + "/greenguard_knowledge"
        knowledge_app = f"postgresql://knowledge_app:{knowledge_app_password}@127.0.0.1:{port}/greenguard_knowledge"
        knowledge_provisioner = f"postgresql://knowledge_provisioner:{knowledge_provisioner_password}@127.0.0.1:{port}/greenguard_knowledge"
        with psycopg.connect(admin, autocommit=True) as db:
            db.execute(sql.SQL("CREATE ROLE knowledge_app LOGIN PASSWORD {} NOBYPASSRLS")
                       .format(sql.Literal(knowledge_app_password)))
            db.execute(sql.SQL("CREATE ROLE knowledge_provisioner LOGIN PASSWORD {} NOBYPASSRLS")
                       .format(sql.Literal(knowledge_provisioner_password)))
            db.execute(sql.SQL("CREATE ROLE knowledge_reviewer LOGIN PASSWORD {} NOBYPASSRLS")
                       .format(sql.Literal(knowledge_reviewer_password)))
            db.execute("CREATE DATABASE greenguard_knowledge")
        migration_env = dict(os.environ, KNOWLEDGE_ENVIRONMENT="local-synthetic",
            KNOWLEDGE_MIGRATION_DATABASE_URL=knowledge_admin,
            PYTHONPATH=str(KNOWLEDGE_ROOT))
        subprocess.run([sys.executable, str(KNOWLEDGE_ROOT / "migrate.py")],
            cwd=ROOT, env=migration_env, check=True, stdout=subprocess.DEVNULL)

        cert_path, key_path = pem_server(Path(work.name))
        jwks_bytes = os.environ["E2E_DELEGATED_JWKS"].encode()

        class JwksHandler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self):
                if self.path != "/jwks":
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(jwks_bytes)))
                self.end_headers()
                self.wfile.write(jwks_bytes)

        tls_http = HTTPServer(("127.0.0.1", 0), JwksHandler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(cert_path), str(key_path))
        tls_http.socket = context.wrap_socket(tls_http.socket, server_side=True)
        tls_thread = threading.Thread(target=tls_http.serve_forever, daemon=True)
        tls_thread.start()
        jwks_url = f"https://localhost:{tls_http.server_port}/jwks"

        advisor_http = configured_server(
            issuer=os.environ["E2E_DELEGATED_ISSUER"],
            jwks_url=jwks_url,
            membership_url=os.environ["E2E_CONTROL_URL"],
            membership_service_token=os.environ["E2E_CONTROL_TOKEN"],
            database_url=app,
            workflow_database_url=checkpoint,
            alerts_origin=os.environ["E2E_ALERTS_URL"],
            alerts_service_token=os.environ["E2E_ALERTS_SERVICE_TOKEN"],
            host="127.0.0.1", port=0,
        )
        server_thread = threading.Thread(target=advisor_http.serve_forever, daemon=True)
        server_thread.start()
        with urllib_request(jwks_url) as response:
            if response.status != 200:
                raise RuntimeError("Advisor HTTPS JWKS readiness failed")
        with psycopg.connect(app, connect_timeout=2) as db:
            if db.execute("SELECT 1").fetchone()[0] != 1:
                raise RuntimeError("Advisor app DB readiness failed")
        with psycopg.connect(checkpoint, connect_timeout=2) as db:
            if db.execute("SELECT 1").fetchone()[0] != 1:
                raise RuntimeError("Advisor checkpoint DB readiness failed")

        stable_principal = os.environ["E2E_KNOWLEDGE_PRINCIPAL"]
        os.environ["KNOWLEDGE_ENVIRONMENT"] = "local-synthetic"
        dex_issuer = os.environ["E2E_DEX_ISSUER"]
        dex_subject = os.environ["E2E_DEX_SUBJECT"]
        knowledge_connect = lambda: psycopg.connect(knowledge_app, connect_timeout=3,
            options="-c statement_timeout=10000 -c lock_timeout=2000")
        with psycopg.connect(knowledge_provisioner) as db:
            provision(db, tenant_id=os.environ["E2E_TENANT"], issuer=dex_issuer,
                subject=dex_subject, principal_id=stable_principal, roles=["admin"],
                active=True, expected_revision=0, actor_id=stable_principal,
                reason="joined local Dex RAG acceptance", allow_local_http=True)
        primary_auth = OidcAuthenticator(issuer=dex_issuer,
            audience="greenguard-dashboard", jwks_url=os.environ["E2E_DEX_JWKS"],
            memberships=PostgresMemberships(knowledge_connect), allow_local_http=True)
        delegated_auth = OidcAuthenticator(issuer=os.environ["E2E_DELEGATED_ISSUER"],
            audience="knowledge-service",
            jwks_url=os.environ["E2E_BFF_JWKS_URL"],
            memberships=PostgresMemberships(knowledge_connect), allow_local_http=True)
        models = type("LocalModels", (), {})()
        embedder, reranker, answerer = LocalEmbedding(), LocalReranker(), LocalAnswerGenerator()
        models.embedding_model = embedder.model
        models.reranker_model = reranker.model
        models.answer_model = answerer.model
        models.embed = embedder.embed
        models.rerank = reranker.rerank
        models.answer = answerer.answer
        from postgres_acceptance import LocalObjectStore, NAMESPACE_KEY
        local_vectors = LocalVectorStore()
        knowledge_service = KnowledgeRagService(connect=knowledge_connect,
            vector_store=local_vectors, model_gateway=models,
            namespace_key=NAMESPACE_KEY, embedding_model=models.embedding_model,
            reranker_model=models.reranker_model, answer_model=models.answer_model,
            object_store=LocalObjectStore())
        rag_document_id = str(uuid4())
        ingested = knowledge_service.ingest_pdf(tenant_id=os.environ["E2E_TENANT"],
            document_id=rag_document_id, document_version=1,
            pdf_bytes=make_text_pdf([["Wheat Storage", "Keep wheat dry and ventilate stored grain to reduce mold risk."]]),
            min_role="viewer", principal_id=stable_principal, principal_role="admin")
        processed = knowledge_service.process_document_event(
            tenant_id=os.environ["E2E_TENANT"], document_id=rag_document_id,
            document_version=1, event_id=ingested.event_id)
        if processed < 1:
            raise RuntimeError("local RAG fixture did not index any chunks")
        knowledge_auth = CompositeOidcAuthenticator(primary_auth, delegated_auth)
        knowledge_http = create_knowledge_server(service=knowledge_service,
            authenticator=knowledge_auth, host="127.0.0.1", port=0)
        knowledge_thread = threading.Thread(target=knowledge_http.serve_forever, daemon=True)
        knowledge_thread.start()
        knowledge_url = f"http://127.0.0.1:{knowledge_http.server_port}"
        with urllib_request(knowledge_url + "/readyz") as response:
            if response.status != 200:
                raise RuntimeError("Knowledge RAG readiness failed")

        def stop_handler(*_): stop.set()
        signal.signal(signal.SIGTERM, stop_handler)
        signal.signal(signal.SIGINT, stop_handler)
        print(json.dumps({"advisor_url": f"http://127.0.0.1:{advisor_http.server_port}",
                          "knowledge_url": knowledge_url, "document_id": rag_document_id,
                          "jwks_url": jwks_url, "pid": os.getpid()}), flush=True)
        stop.wait()
    finally:
        if advisor_http is not None:
            advisor_http.shutdown()
            advisor_http.server_close()
            if server_thread is not None:
                server_thread.join(timeout=3)
            saver_context = getattr(advisor_http, "workflow_context", None)
            if saver_context is not None:
                saver_context.__exit__(None, None, None)
        if knowledge_http is not None:
            knowledge_http.shutdown()
            knowledge_http.server_close()
            if knowledge_thread is not None:
                knowledge_thread.join(timeout=3)
        if tls_http is not None:
            tls_http.shutdown()
            tls_http.server_close()
            if tls_thread is not None:
                tls_thread.join(timeout=3)
        try:
            docker("rm", "-f", container)
        except Exception:
            pass
        work.cleanup()


def urllib_request(url):
    from urllib.request import urlopen
    return urlopen(url, timeout=2)


if __name__ == "__main__":
    main()
