"""OIDC bearer verification for operator-owned grain policy routes."""

from __future__ import annotations

import json
import math
import os
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from urllib.parse import urlsplit

import jwt
from jwt import PyJWKClient, PyJWKClientConnectionError, PyJWKClientError, PyJWKError

from risk_engine.policy_service import VerifiedPrincipal

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
_BEARER = re.compile(r"(?i)^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$")


class AuthenticationError(Exception):
    def __init__(self, status: int, code: str):
        self.status, self.code = status, code
        super().__init__(code)


@dataclass(frozen=True)
class OIDCConfig:
    issuer: str
    audience: str | None
    jwks_url: str
    memberships: Mapping[str, Mapping[str, object]] | None = None
    allow_signed_claims_for_development: bool = False
    token_mode: str = "audience"
    cognito_client_ids: tuple[str, ...] = ()


class OIDCVerifier:
    """Verify signed user tokens and derive tenant membership from trusted claims/map."""

    def __init__(self, config: OIDCConfig, jwks_client: PyJWKClient | None = None):
        self.config = config
        self.jwks = jwks_client or PyJWKClient(config.jwks_url, cache_keys=True, timeout=5)

    @classmethod
    def from_env(cls, getenv: Callable[[str], str | None] = os.environ.get) -> OIDCVerifier | None:
        token_mode = getenv("AUTH_TOKEN_MODE") or "audience"
        if token_mode not in {"audience", "cognito-access"}:
            raise ValueError("AUTH_TOKEN_MODE must be audience or cognito-access")
        issuer, audience, jwks_url = (getenv("AUTH_ISSUER"), getenv("AUTH_AUDIENCE"), getenv("AUTH_JWKS_URL"))
        if not issuer and not audience and not jwks_url and token_mode == "audience":
            return None
        if not issuer or not jwks_url or (token_mode == "audience" and not audience):
            raise ValueError("AUTH_ISSUER, AUTH_AUDIENCE and AUTH_JWKS_URL must be set together")
        client_ids = tuple(x.strip() for x in (getenv("AUTH_COGNITO_CLIENT_IDS") or "").split(",") if x.strip())
        if token_mode == "cognito-access" and not client_ids:
            raise ValueError("AUTH_COGNITO_CLIENT_IDS is required for cognito-access")
        parts = urlsplit(jwks_url)
        if parts.scheme != "https" and not (parts.scheme == "http" and parts.hostname in {"localhost", "127.0.0.1", "::1"}):
            raise ValueError("AUTH_JWKS_URL must use HTTPS except for loopback development")
        memberships = None
        path = getenv("AUTH_MEMBERSHIP_FILE")
        if path:
            with open(path, encoding="utf-8") as membership_file:
                raw = json.load(membership_file)
            if not isinstance(raw, list):
                raise ValueError("AUTH_MEMBERSHIP_FILE must contain a JSON array")
            memberships = {}
            for entry in raw:
                if not isinstance(entry, dict):
                    raise TypeError("AUTH_MEMBERSHIP_FILE entry must be an object")
                key = f"{entry.get('issuer')}|{entry.get('subject')}"
                tenant_id, roles = entry.get("tenantId"), entry.get("roles")
                if (entry.get("issuer") != issuer or not isinstance(entry.get("subject"), str)
                        or not isinstance(tenant_id, str) or not _UUID.fullmatch(tenant_id)
                        or not isinstance(roles, list) or not roles
                        or any(role not in {"viewer", "operator", "admin", "device"} for role in roles)
                        or key in memberships):
                    raise ValueError("AUTH_MEMBERSHIP_FILE contains an invalid membership")
                memberships[key] = {"tenant_id": tenant_id, "roles": tuple(roles)}
        allow_signed_claims = getenv("AUTH_ALLOW_SIGNED_CLAIMS") == "true"
        if memberships is None and not allow_signed_claims:
            raise ValueError("AUTH_MEMBERSHIP_FILE is required unless AUTH_ALLOW_SIGNED_CLAIMS=true")
        if token_mode == "cognito-access" and memberships is None:
            raise ValueError("cognito-access requires trusted membership mapping")
        return cls(OIDCConfig(issuer, audience, jwks_url, memberships, allow_signed_claims,
                              token_mode, client_ids))

    def verify(self, authorization: str | None) -> VerifiedPrincipal:
        if not authorization:
            raise AuthenticationError(401, "missing_token")
        match = _BEARER.fullmatch(authorization)
        if not match:
            raise AuthenticationError(401, "malformed_header")
        token = match.group(1)
        try:
            signing_key = self.jwks.get_signing_key_from_jwt(token).key
        except PyJWKClientConnectionError:
            raise AuthenticationError(503, "auth_unavailable") from None
        except PyJWKClientError as error:
            # A bad key id is an invalid token; an unavailable JWKS endpoint is a
            # temporary authentication dependency failure.
            if "Unable to find a signing key" in str(error):
                raise AuthenticationError(401, "invalid_token") from None
            raise AuthenticationError(503, "auth_unavailable") from None
        except (PyJWKError, jwt.PyJWTError):
            raise AuthenticationError(401, "invalid_token") from None
        try:
            claims = jwt.decode(
                token, signing_key, algorithms=["RS256"], issuer=self.config.issuer,
                audience=self.config.audience,
                options={"require": ["iss", "exp", "sub"] + (["aud"] if self.config.token_mode == "audience" else []),
                         "verify_aud": self.config.token_mode == "audience"},
                leeway=30,
            )
        except jwt.ExpiredSignatureError:
            raise AuthenticationError(401, "expired_token") from None
        except (jwt.PyJWTError, TypeError, ValueError):
            raise AuthenticationError(401, "invalid_token") from None

        if self.config.token_mode == "cognito-access":
            if (claims.get("token_use") != "access"
                    or claims.get("client_id") not in self.config.cognito_client_ids
                    or not isinstance(claims.get("username"), str) or not claims["username"]
                    or type(claims.get("auth_time")) not in (int, float)
                    or not math.isfinite(claims["auth_time"])
                    or claims.get("sub") == claims.get("client_id")
                    or claims.get("grant_type") == "client_credentials"
                    or claims.get("gty") == "client_credentials"):
                raise AuthenticationError(401, "invalid_token")
            token_audience = claims.get("aud")
            if token_audience is not None:
                audiences = token_audience if isinstance(token_audience, list) else [token_audience]
                if not self.config.audience or self.config.audience not in audiences:
                    raise AuthenticationError(401, "invalid_token")
            elif self.config.audience:
                raise AuthenticationError(401, "invalid_token")

        if (any(claim in claims for claim in ("gty", "grant_type"))
                or claims.get("principal_type") == "service" or "device_id" in claims
                or claims.get("sub") == claims.get("client_id")):
            raise AuthenticationError(403, "unsupported_principal")
        subject = claims.get("sub")
        if not isinstance(subject, str) or not subject:
            raise AuthenticationError(401, "invalid_claims")
        if self.config.memberships is None and self.config.allow_signed_claims_for_development:
            tenant_id, roles = claims.get("tenant_id"), claims.get("roles")
        elif self.config.memberships is not None:
            membership = self.config.memberships.get(f"{claims.get('iss')}|{subject}")
            if membership is None:
                raise AuthenticationError(403, "membership_required")
            tenant_id, roles = membership["tenant_id"], membership["roles"]
        else:
            raise AuthenticationError(503, "auth_membership_not_configured")
        if not isinstance(tenant_id, str) or not _UUID.fullmatch(tenant_id) or not isinstance(roles, (list, tuple)):
            raise AuthenticationError(401, "invalid_claims")
        if "device" in roles or "admin" not in roles:
            raise AuthenticationError(403, "admin_role_required")
        return VerifiedPrincipal(tenant_id, subject, frozenset(roles))
