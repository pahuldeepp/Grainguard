import json
import unittest
from datetime import datetime, timedelta, timezone
from io import BytesIO
from types import SimpleNamespace

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt import PyJWKClientError

from risk_engine.policy_api import PolicyAPI
from risk_engine.policy_auth import AuthenticationError, OIDCConfig, OIDCVerifier

ISSUER = "https://id.example.test/"
AUDIENCE = "greenguard-api"
TENANT = "22222222-2222-4222-8222-222222222222"


class FakeJWKS:
    def __init__(self, key):
        self.key = key
    def get_signing_key_from_jwt(self, token):
        header = jwt.get_unverified_header(token)
        if header.get("kid") != "test-key":
            raise PyJWKClientError("Unable to find a signing key")
        return SimpleNamespace(key=self.key)


class PolicyOIDCTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.public = cls.private.public_key()

    def token(self, **overrides):
        now = datetime.now(timezone.utc)
        claims = {
            "iss": ISSUER, "aud": AUDIENCE, "sub": "human-operator",
            "tenant_id": TENANT, "roles": ["admin"], "iat": now,
            "nbf": now - timedelta(seconds=1), "exp": now + timedelta(minutes=5),
        }
        claims.update(overrides)
        return jwt.encode(claims, self.private, algorithm="RS256", headers={"kid": "test-key"})

    def verifier(self, memberships=None, allow_claims=False):
        if memberships is None and not allow_claims:
            memberships = {f"{ISSUER}|human-operator": {"tenant_id": TENANT, "roles": ("admin",)}}
        return OIDCVerifier(OIDCConfig(ISSUER, AUDIENCE, "https://id.example.test/jwks", memberships, allow_claims),
                            FakeJWKS(self.public))

    def test_cognito_access_mode_accepts_only_mapped_human_access_tokens(self):
        memberships = {f"{ISSUER}|human-operator": {"tenant_id": TENANT, "roles": ("admin",)}}
        config = OIDCConfig(ISSUER, None, "https://id.example.test/jwks", memberships,
                            False, "cognito-access", ("ios-client",))
        verifier = OIDCVerifier(config, FakeJWKS(self.public))
        human = {"aud": None, "token_use": "access", "client_id": "ios-client",
                 "username": "operator", "auth_time": int(datetime.now(timezone.utc).timestamp())}
        self.assertEqual(verifier.verify("Bearer " + self.token(**human)).tenant_id, TENANT)
        for bad in ({"token_use": "id"}, {"client_id": "wrong-client"},
                    {"username": None}, {"auth_time": None},
                    {"grant_type": "client_credentials"}, {"aud": "https://other.example"}):
            with self.subTest(bad=bad), self.assertRaises(AuthenticationError) as ctx:
                verifier.verify("Bearer " + self.token(**(human | bad)))
            self.assertEqual(ctx.exception.status, 401)
        resource_config = OIDCConfig(ISSUER, "https://api.greenguard.example", "https://id.example.test/jwks",
                                     memberships, False, "cognito-access", ("ios-client",))
        resource_verifier = OIDCVerifier(resource_config, FakeJWKS(self.public))
        resource_verifier.verify("Bearer " + self.token(**(human | {"aud": "https://api.greenguard.example"})))
        with self.assertRaises(AuthenticationError):
            resource_verifier.verify("Bearer " + self.token(**human))

    def test_valid_signed_tenant_admin_returns_verified_principal(self):
        principal = self.verifier().verify("Bearer " + self.token())
        self.assertEqual((principal.tenant_id, principal.subject), (TENANT, "human-operator"))
        self.assertEqual(principal.roles, frozenset({"admin"}))

    def test_membership_mapping_overrides_signed_tenant_and_roles(self):
        membership = {f"{ISSUER}|human-operator": {"tenant_id": TENANT, "roles": ("admin",)}}
        principal = self.verifier(membership).verify(
            "Bearer " + self.token(tenant_id="44444444-4444-4444-8444-444444444444", roles=["viewer"]))
        self.assertEqual(principal.tenant_id, TENANT)
        self.assertEqual(principal.roles, frozenset({"admin"}))

    def test_rejects_wrong_issuer_audience_expiry_and_not_before(self):
        for claims in (
            {"iss": "https://other.example/"},
            {"aud": "other"},
            {"exp": datetime.now(timezone.utc) - timedelta(minutes=1)},
            {"nbf": datetime.now(timezone.utc) + timedelta(minutes=3)},
        ):
            with self.subTest(claims=claims), self.assertRaises(AuthenticationError) as ctx:
                self.verifier().verify("Bearer " + self.token(**claims))
            self.assertEqual(ctx.exception.status, 401)

    def test_rejects_machine_device_and_non_admin_principals(self):
        for claims in (
            {"gty": "client-credentials"},
            {"grant_type": "client_credentials"},
            {"principal_type": "service"},
            {"device_id": "device"},
            {"roles": ["device"]},
            {"roles": ["operator"]},
        ):
            with self.subTest(claims=claims), self.assertRaises(AuthenticationError) as ctx:
                self.verifier(allow_claims=True).verify("Bearer " + self.token(**claims))
            self.assertEqual(ctx.exception.status, 403)

    def test_membership_miss_is_denied_and_auth_header_is_strict(self):
        with self.assertRaises(AuthenticationError):
            self.verifier({}).verify("Bearer " + self.token())
        with self.assertRaises(AuthenticationError) as ctx:
            OIDCVerifier(OIDCConfig(ISSUER, AUDIENCE, "https://id.example.test/jwks"),
                         FakeJWKS(self.public)).verify("Bearer " + self.token())
        self.assertEqual(ctx.exception.status, 503)
        for header in (None, "Basic abc", "Bearer invalid", "Bearer " + self.token() + " trailing"):
            with self.subTest(header=str(header)[:30]), self.assertRaises(AuthenticationError):
                self.verifier().verify(header)

    def test_algorithm_substitution_is_rejected(self):
        token = jwt.encode({"sub": "human"}, "a test secret that is at least thirty two bytes long", algorithm="HS256", headers={"kid": "test-key"})
        with self.assertRaises(AuthenticationError):
            self.verifier().verify("Bearer " + token)

    def test_http_publication_binds_verified_tenant_and_rejects_tenant_input(self):
        class Service:
            def __init__(self): self.calls = []
            def publish(self, principal, policy):
                self.calls.append((principal, policy))
                return {"event_type": "risk.policy_changed", "tenant_id": principal.tenant_id}
            def effective(self, *_): return None
        class Handler:
            def __init__(self, method, path, authorization, body=b""):
                self.command, self.path = method, path
                self.headers = {"Authorization": authorization, "Content-Length": str(len(body))}
                self.rfile = BytesIO(body)
                self.wfile = self
                self.status = None
                self.response_headers = {}
                self.response = b""
            def send_response(self, status): self.status = status
            def send_header(self, key, value): self.response_headers[key] = value
            def end_headers(self): pass
            def write(self, data): self.response = data
        service = Service()
        api = PolicyAPI(service, self.verifier())
        body = {
            "policy_id": "33333333-3333-4333-8333-333333333333", "version": 1,
            "grain_type": "wheat", "bin_id": None,
            "effective_from": "2026-09-26T00:00:00Z", "effective_to": None,
            "measurement_thresholds": {}, "risk_thresholds": {"warning_score": 50, "critical_score": 75},
            "calibrated": False, "status": "draft", "provenance": {"source": "synthetic"},
            "calibration_evidence": None, "approved_by": None, "approved_at": None,
        }
        auth = "Bearer " + self.token()
        request = Handler("POST", "/v1/policies", auth, json.dumps(body).encode())
        self.assertTrue(api.handle(request))
        self.assertEqual(request.status, 201)
        self.assertEqual(service.calls[0][0].tenant_id, TENANT)
        self.assertEqual(service.calls[0][1].calibrated, False)

        body["tenant_id"] = "44444444-4444-4444-8444-444444444444"
        request = Handler("POST", "/v1/policies", auth, json.dumps(body).encode())
        api.handle(request)
        self.assertEqual(request.status, 400)
        self.assertEqual(len(service.calls), 1)

        request = Handler("POST", "/v1/policies", None, json.dumps(body).encode())
        api.handle(request)
        self.assertEqual(request.status, 401)


if __name__ == "__main__":
    unittest.main()
