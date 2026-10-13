"""Start the authenticated knowledge HTTP service behind a trusted ingress."""

from __future__ import annotations

import os
import sys
import json
import signal
import threading
import time

import psycopg

from knowledge_extensions.http_api import create_server
from knowledge_extensions.model_gateway import ModelGatewayClient
from knowledge_extensions.object_storage import S3PdfObjectStore, S3SourceConfig
from knowledge_extensions.service import KnowledgeRagService
from knowledge_extensions.vector_store import PineconeVectorStore
from knowledge_extensions.oidc_auth import (CompositeOidcAuthenticator, ControlPlaneMemberships,
    OidcAuthenticator, PostgresMemberships)


def _required(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise SystemExit(f"missing required environment variable: {name}")
    return value


def _provider_secret(name: str) -> str:
    path=os.environ.get(name+"_FILE")
    if not path:
        return _required(name)
    import stat
    info=os.stat(path)
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077:
        raise SystemExit("provider key file must be a protected regular file")
    with open(path,encoding="utf-8") as handle:
        value=handle.read(4096).strip()
    if not value:
        raise SystemExit("provider key file is empty")
    return value


def _tenant_gateway_tokens(path: str) -> dict[str, str]:
    with open(path, "r", encoding="utf-8") as handle:
        tokens = json.load(handle)
    if not isinstance(tokens, dict) or not tokens or any(
        not isinstance(tenant, str) or not isinstance(token, str) or not token
        for tenant, token in tokens.items()
    ):
        raise SystemExit("model gateway task token file is invalid")
    return tokens


def _membership_authority(connect):
    source = os.environ.get("KNOWLEDGE_MEMBERSHIP_SOURCE", "control-plane")
    if source == "control-plane":
        return ControlPlaneMemberships(
            base_url=_required("CONTROL_PLANE_URL"),
            token=_required("CONTROL_LOOKUP_TOKEN"),
            allow_mesh_http=os.environ.get("CONTROL_PLANE_MESH_MTLS") == "true",
        )
    if source == "postgres" and os.environ.get("KNOWLEDGE_ENVIRONMENT") == "local-synthetic":
        # Local fixtures may opt into the legacy owner mirror explicitly.
        return PostgresMemberships(connect)
    raise SystemExit("KNOWLEDGE_MEMBERSHIP_SOURCE must be control-plane (or postgres in local-synthetic only)")


def main() -> None:
    dsn = _required("KNOWLEDGE_DATABASE_URL")
    connect=lambda: psycopg.connect(dsn, connect_timeout=5, options="-c statement_timeout=10000 -c lock_timeout=2000")
    memberships = _membership_authority(connect)
    token_mode=os.environ.get("AUTH_TOKEN_MODE", "audience")
    audience=os.environ.get("AUTH_AUDIENCE", "")
    client_ids=tuple(item for item in os.environ.get("AUTH_CLIENT_IDS", "").split(",") if item)
    if token_mode not in {"audience", "cognito-access"}:
        raise SystemExit("AUTH_TOKEN_MODE must be audience or cognito-access")
    if token_mode == "audience" and (not audience or client_ids):
        raise SystemExit("audience mode requires AUTH_AUDIENCE and forbids AUTH_CLIENT_IDS")
    if token_mode == "cognito-access" and (audience or not client_ids or len(set(client_ids)) != len(client_ids)):
        raise SystemExit("cognito-access requires an exact unique AUTH_CLIENT_IDS allowlist and no audience")
    authenticator=OidcAuthenticator(
        issuer=_required("AUTH_ISSUER"),audience=audience,
        jwks_url=_required("AUTH_JWKS_URL"),memberships=memberships,
        allow_local_http=os.environ.get("AUTH_ALLOW_LOCAL_HTTP")=="true",
        token_mode=token_mode, client_ids=client_ids,
    )
    delegated_issuer = os.environ.get("DELEGATED_ISSUER")
    delegated_jwks = os.environ.get("DELEGATED_JWKS_URL")
    if bool(delegated_issuer) != bool(delegated_jwks):
        raise SystemExit("DELEGATED_ISSUER and DELEGATED_JWKS_URL must be set together")
    if delegated_issuer and delegated_jwks:
        authenticator = CompositeOidcAuthenticator(
            authenticator,
            OidcAuthenticator(
                issuer=delegated_issuer,
                delegated_mode=True,
                audience="knowledge-service",
                jwks_url=delegated_jwks,
                memberships=memberships,
                allow_local_http=os.environ.get("AUTH_ALLOW_LOCAL_HTTP")=="true",
            ),
        )
    gateway_tokens = _tenant_gateway_tokens(_required("KNOWLEDGE_MODEL_GATEWAY_TOKENS_FILE"))
    namespace_key = bytes.fromhex(_required("KNOWLEDGE_NAMESPACE_HMAC_KEY"))
    if len(namespace_key) < 32:
        raise SystemExit("KNOWLEDGE_NAMESPACE_HMAC_KEY must contain at least 32 bytes in hex")
    object_store = S3PdfObjectStore(S3SourceConfig(
        bucket=_required("KNOWLEDGE_S3_BUCKET"),
        region=_required("KNOWLEDGE_S3_REGION"),
        kms_key_id=_required("KNOWLEDGE_S3_KMS_KEY_ID"),
        endpoint_url=os.environ.get("KNOWLEDGE_S3_ENDPOINT") or None,
    ))
    base_url = _required("KNOWLEDGE_MODEL_GATEWAY_URL")

    def model_for(tenant_id: str) -> str:
        token = gateway_tokens.get(tenant_id)
        if token is None:
            raise RuntimeError("no model gateway token is provisioned for tenant")
        return token

    model_gateway = ModelGatewayClient(base_url=base_url, task_token=model_for,
                                       allow_mesh_http=os.environ.get("KNOWLEDGE_MODEL_GATEWAY_MESH_MTLS") == "true")
    vector_store = PineconeVectorStore(
        index_host=_required("PINECONE_INDEX_HOST"), api_key=_provider_secret("PINECONE_API_KEY"),
    )
    from knowledge_extensions.retrieval_cache import RedisJsonCache
    cache_url = os.environ.get("KNOWLEDGE_REDIS_URL")
    cache_file = os.environ.get("KNOWLEDGE_REDIS_URL_FILE")
    if cache_file:
        cache_url = _provider_secret("KNOWLEDGE_REDIS_URL")
    retrieval_cache = RedisJsonCache(cache_url, ca_file=os.environ.get("KNOWLEDGE_REDIS_CA_FILE")) if cache_url else None
    service = KnowledgeRagService(
        connect=connect, vector_store=vector_store,
        model_gateway=model_gateway, namespace_key=namespace_key,
        embedding_model=_required("KNOWLEDGE_EMBEDDING_MODEL"),
        reranker_model=_required("KNOWLEDGE_RERANKER_MODEL"),
        answer_model=_required("KNOWLEDGE_ANSWER_MODEL"),
        structured_planner_model=os.environ.get("KNOWLEDGE_STRUCTURED_PLANNER_MODEL") or None,
        object_store=object_store, retrieval_cache=retrieval_cache,
        evaluation_report_file=os.environ.get("KNOWLEDGE_SYNTHETIC_EVALUATION_REPORT_FILE"),
    )
    host = os.environ.get("KNOWLEDGE_LISTEN_HOST", "127.0.0.1")
    try:
        port = int(os.environ.get("KNOWLEDGE_LISTEN_PORT", "8080"))
    except ValueError as exc:
        raise SystemExit("KNOWLEDGE_LISTEN_PORT must be a port number") from exc
    server = create_server(service=service, authenticator=authenticator, host=host, port=port)
    drain_seconds = float(os.environ.get('KNOWLEDGE_DRAIN_SECONDS', '5'))
    if not 0 <= drain_seconds <= 30:
        raise SystemExit('KNOWLEDGE_DRAIN_SECONDS must be between 0 and 30')
    print(f"knowledge-service listening on {host}:{port}", file=sys.stderr)
    def begin_shutdown(*_args):
        server.draining = True
        def finish_shutdown():
            server.wait_for_handlers(drain_seconds)
            server.shutdown()
        threading.Thread(target=finish_shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, begin_shutdown)
    signal.signal(signal.SIGINT, begin_shutdown)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
