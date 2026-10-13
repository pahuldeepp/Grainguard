"""Regression checks for strict quality refactors and failure boundaries."""
import copy
import json
import ssl
import tempfile
import unittest
from datetime import timedelta
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.parse import urlencode

from jwt import PyJWKClientConnectionError, PyJWKClientError, PyJWKError

from risk_engine.apply import APPLIED, DUPLICATE, QUARANTINE, deterministic_ids
from risk_engine.events import InvalidEvent, TELEMETRY_V2_TOPIC, parse
from risk_engine.kafka_source import _security_config
from risk_engine.policy import validate_policy
from risk_engine.policy_api import PolicyAPI, _parse_policy
from risk_engine.policy_auth import AuthenticationError, OIDCConfig, OIDCVerifier, _BEARER
from risk_engine.policy_service import VerifiedPrincipal
from risk_engine.shards import ShardedDatabase, validate_route
from risk_engine.store import StoreError
from test_fakes import ROOT, FakeTx
from test_apply import Scenario
from test_policy_auth import ISSUER, AUDIENCE, TENANT
from test_policy_domain import NOW, policy
from test_shards import TENANT as SHARD_TENANT, manifest, route


class TelemetryValidationRegressionTest(unittest.TestCase):
    def setUp(self):
        self.event = json.loads((ROOT / "tests/fixtures/events/telemetry-recorded.v2.valid.json").read_text())

    def test_sensor_validation_rejects_invalid_layout_and_physical_values(self):
        for changes, message in (
            ({"position": True}, "sensor position"),
            ({"position": 0}, "sensor position"),
            ({"depth_m": -1}, "sensor depth"),
            ({"depth_m": True}, "sensor depth"),
            ({"depth_m": float("nan")}, "sensor depth"),
            ({"metric": []}, "metric/unit mismatch"),
            ({"unit": "invalid"}, "metric/unit mismatch"),
            ({"value": True}, "value must be finite"),
            ({"value": float("inf")}, "value must be finite"),
            ({"value": -81}, "physical range"),
            ({"layout_version": "0"}, "layout_version"),
            ({"extra": 1}, "fields do not match"),
        ):
            event = copy.deepcopy(self.event)
            event["payload"]["sensor_observations"][0].update(changes)
            encoded = json.dumps(event).encode()
            with self.subTest(changes=changes), self.assertRaisesRegex(InvalidEvent, message):
                parse(TELEMETRY_V2_TOPIC, encoded)

    def test_v2_scalar_contract_and_numeric_validation_remain_strict(self):
        for payload_changes, message in (
            ({"measurements": {"temperature_c": True}, "measurement_units": {"temperature_c": "Cel"}}, "finite numeric"),
            ({"measurements": {"temperature_c": 121}, "measurement_units": {"temperature_c": "Cel"}}, "physical range"),
            ({"measurement_units": {}}, "exactly match"),
            ({"source_message_id": "has spaces"}, "source_message_id"),
            ({"sensor_observations": {}}, "at most 256"),
            ({"sensor_observations": [None]}, "must be an object"),
            ({"sensor_observations": [self.event["payload"]["sensor_observations"][0]] * 257}, "at most 256"),
            ({"extra": 1}, "fields do not match"),
        ):
            event = copy.deepcopy(self.event)
            event["payload"].update(payload_changes)
            encoded = json.dumps(event).encode()
            with self.subTest(message=message), self.assertRaisesRegex(InvalidEvent, message):
                parse(TELEMETRY_V2_TOPIC, encoded)

    def test_sensor_only_reading_keeps_layout_and_optional_depth(self):
        self.event["payload"].update(measurements={}, measurement_units={})
        self.event["payload"]["sensor_observations"][0]["depth_m"] = None
        encoded = json.dumps(self.event).encode()
        result = parse(TELEMETRY_V2_TOPIC, encoded)
        expected_measurements = {}
        self.assertEqual(expected_measurements, result.measurements)
        self.assertEqual(tuple(self.event["payload"]["sensor_observations"]), result.sensor_observations)


class PolicyValidationRegressionTest(unittest.TestCase):
    def test_policy_rejects_metadata_and_threshold_boundary_errors(self):
        for changes, message in (
            ({"grain_type": "WHEAT"}, "lowercase"),
            ({"version": 0}, "positive"),
            ({"effective_from": NOW.replace(tzinfo=None)}, "effective_from must be UTC"),
            ({"effective_to": NOW.replace(tzinfo=None)}, "effective_to must be UTC"),
            ({"approved_at": NOW.replace(tzinfo=None)}, "approved_at must be UTC"),
            ({"effective_to": NOW}, "after effective_from"),
            ({"status": "disabled"}, "draft or active"),
            ({"measurement_thresholds": {"unknown": {}}}, "unsupported measurement"),
            ({"measurement_thresholds": {"temperature_c": {"unit": "Cel", "warning": True}}}, "must be finite"),
            ({"measurement_thresholds": {"temperature_c": {"unit": "Cel", "warning": -81}}}, "physical range"),
            ({"measurement_thresholds": {"temperature_c": {"unit": "Cel", "critical": 121}}}, "physical range"),
            ({"measurement_thresholds": {"temperature_c": {"unit": "Cel", "unknown": 1}}}, "unknown threshold"),
            ({"risk_thresholds": {"warning_score": True, "critical_score": 75}}, "integer"),
            ({"risk_thresholds": {"warning_score": 75, "critical_score": 75}}, "below critical_score"),
            ({"risk_thresholds": {"warning_score": 50}}, "contain warning_score"),
            ({"provenance": {}}, "provenance is required"),
        ):
            value = policy(**changes)
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, message):
                validate_policy(value)

    def test_optional_metric_bounds_and_half_open_policy_interval(self):
        value = policy(effective_to=NOW + timedelta(seconds=1), measurement_thresholds={
            "temperature_c": {"unit": "Cel", "warning": -80, "critical": 120},
            "co2_ppm": {"unit": "ppm", "warning": 0, "critical": 1000000},
        })
        validate_policy(value)

    def test_api_parsing_rejects_boolean_versions_and_wrong_object_types(self):
        body = policy().as_dict()
        body["version"] = 1
        for changes, error, message in (
            ({"version": True}, ValueError, "positive integer"),
            ({"policy_id": "invalid"}, ValueError, "canonical UUID"),
            ({"bin_id": "invalid"}, ValueError, "canonical UUID or null"),
            ({"grain_type": None}, TypeError, "must be strings"),
            ({"calibrated": "false"}, TypeError, "must be boolean"),
            ({"provenance": []}, TypeError, "must be an object"),
            ({"approved_by": 42}, ValueError, "string or null"),
        ):
            request_body = body | changes
            with self.subTest(changes=changes), self.assertRaisesRegex(error, message):
                _parse_policy(request_body, TENANT)


class PolicyAuthenticationRegressionTest(unittest.TestCase):
    def config(self, **changes):
        env = {"AUTH_ISSUER": ISSUER, "AUTH_AUDIENCE": AUDIENCE,
               "AUTH_JWKS_URL": "https://id.example.test/jwks", "AUTH_ALLOW_SIGNED_CLAIMS": "true"}
        env.update(changes)
        return env

    def test_membership_file_rejects_invalid_and_duplicate_mapping(self):
        entry = {"issuer": ISSUER, "subject": "admin", "tenantId": TENANT, "roles": ["admin"]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "memberships.json"
            for contents, error in (({}, ValueError), ([None], TypeError),
                                    ([entry, entry], ValueError),
                                    ([entry | {"roles": ["owner"]}], ValueError),
                                    ([entry | {"tenantId": "invalid"}], ValueError)):
                path.write_text(json.dumps(contents))
                env = self.config(AUTH_MEMBERSHIP_FILE=str(path))
                with self.subTest(contents=contents), self.assertRaises(error):
                    OIDCVerifier.from_env(env.get)
            path.write_text(json.dumps([entry]))
            env = self.config(AUTH_MEMBERSHIP_FILE=str(path))
            verifier = OIDCVerifier.from_env(env.get)
            self.assertEqual(TENANT, verifier.config.memberships[f"{ISSUER}|admin"]["tenant_id"])

    def test_env_fails_closed_for_missing_mapping_and_insecure_jwks(self):
        for changes, message in (
            ({"AUTH_JWKS_URL": "http://public.example/jwks"}, "HTTPS"),
            ({"AUTH_ALLOW_SIGNED_CLAIMS": "false"}, "AUTH_MEMBERSHIP_FILE"),
            ({"AUTH_TOKEN_MODE": "cognito-access"}, "CLIENT_IDS"),
            ({"AUTH_TOKEN_MODE": "cognito-access", "AUTH_COGNITO_CLIENT_IDS": "ios"}, "trusted membership"),
            ({"AUTH_TOKEN_MODE": "invalid"}, "TOKEN_MODE"),
            ({"AUTH_ISSUER": None}, "set together"),
        ):
            env = self.config(**changes)
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, message):
                OIDCVerifier.from_env(env.get)
        self.assertIsNone(OIDCVerifier.from_env({}.get))
        env = self.config(AUTH_JWKS_URL="http://127.0.0.1/jwks")
        self.assertIsNotNone(OIDCVerifier.from_env(env.get))

    def test_jwks_failure_status_preserves_dependency_vs_token_error(self):
        for error, status in ((PyJWKClientConnectionError("offline"), 503),
                              (PyJWKClientError("offline"), 503),
                              (PyJWKClientError("Unable to find a signing key"), 401),
                              (PyJWKError("invalid key"), 401)):
            jwks = Mock()
            jwks.get_signing_key_from_jwt.side_effect = error
            verifier = OIDCVerifier(OIDCConfig(ISSUER, AUDIENCE, "https://id.example.test/jwks"), jwks)
            with self.subTest(status=status), self.assertRaises(AuthenticationError) as result:
                verifier.verify("Bearer abc.def.ghi")
            self.assertEqual(status, result.exception.status)

    def test_cognito_user_validation_and_audience_array(self):
        verifier = OIDCVerifier(OIDCConfig(ISSUER, AUDIENCE, "https://id.example.test/jwks",
                                          token_mode="cognito-access", cognito_client_ids=("ios",)), Mock())
        human = {"token_use": "access", "client_id": "ios", "username": "admin",
                 "auth_time": 100, "sub": "human", "aud": [AUDIENCE]}
        verifier._verify_cognito_claims(human)
        for changes in ({"auth_time": True}, {"auth_time": float("nan")}, {"username": ""},
                        {"sub": "ios"}, {"gty": "client_credentials"}, {"aud": []}):
            claims = human | changes
            with self.subTest(changes=changes), self.assertRaises(AuthenticationError) as result:
                verifier._verify_cognito_claims(claims)
            if result.exception.status != 401:
                self.fail(f"expected unauthorized status, got {result.exception.status}")

    def test_bearer_regex_preserves_case_insensitivity_and_strict_whitespace(self):
        self.assertIsNotNone(_BEARER.fullmatch("bEaReR ABC.def.GHI_123-"))
        self.assertIsNone(_BEARER.fullmatch("Bearer  abc.def.ghi"))
        self.assertIsNone(_BEARER.fullmatch("Bearer abc.def.ghi\n"))


class Handler:
    def __init__(self, command="POST", path="/v1/policies", body=b"{}"):
        self.command, self.path = command, path
        self.headers = {"Authorization": "Bearer fixture", "Content-Length": str(len(body))}
        self.rfile, self.wfile = BytesIO(body), BytesIO()
        self.status = None
        self.response_headers = {}

    def send_response(self, status): self.status = status
    def send_header(self, key, value): self.response_headers[key] = value
    def end_headers(self): pass


class PolicyAPIRegressionTest(unittest.TestCase):
    def setUp(self):
        self.service, verifier = Mock(), Mock()
        self.principal = VerifiedPrincipal(TENANT, "admin", frozenset({"admin"}))
        verifier.verify.return_value = self.principal
        self.api = PolicyAPI(self.service, verifier)
        self.body = policy().as_dict()
        self.body["version"] = 1

    def test_get_policy_uses_verified_tenant_and_grain_wide_sentinel(self):
        self.service.effective.return_value = None
        query = urlencode({"grain_type": "wheat", "bin_id": "*", "at": "2026-09-26T00:00:00Z"})
        request = Handler("GET", "/v1/policies?" + query)
        self.assertTrue(self.api.handle(request))
        self.assertEqual(404, request.status)
        self.service.effective.assert_called_once_with(self.principal, "00000000-0000-0000-0000-000000000000", "wheat", NOW)
        self.service.effective.return_value = policy()
        self.api.handle(request)
        self.assertEqual(200, request.status)
        self.assertEqual("no-store", request.response_headers["Cache-Control"])

    def test_method_and_query_validation(self):
        for command, path, status in (("POST", "/v1/policies?unexpected=x", 405),
                                      ("GET", "/v1/policies", 405),
                                      ("DELETE", "/v1/policies", 405),
                                      ("GET", "/v1/policies?grain_type=wheat", 400),
                                      ("GET", "/v1/policies?grain_type=x&bin_id=bad&at=2026-09-26T00:00:00Z", 400)):
            request = Handler(command, path)
            self.api.handle(request)
            self.assertEqual(status, request.status)
        self.service.publish.assert_not_called()
        self.service.effective.assert_not_called()

    def test_post_input_and_service_failure_response_codes(self):
        for body, length, status in ((b"{}", "0", 413), (b"{}", "65537", 413),
                                     (b"{}", "bad", 400), (b"{bad", "4", 400)):
            request = Handler(body=body)
            request.headers["Content-Length"] = length
            self.api.handle(request)
            self.assertEqual(status, request.status)
        self.service.publish.assert_not_called()
        for error, status in ((PermissionError("denied"), 403), (TimeoutError(), 408),
                              (StoreError("23505", "duplicate"), 409),
                              (StoreError("42501", "denied"), 503),
                              (StoreError(None, "unavailable"), 503)):
            self.service.publish.side_effect = error
            request = Handler(body=json.dumps(self.body).encode())
            self.api.handle(request)
            self.assertEqual(status, request.status)


class SecurityTransportRegressionTest(unittest.TestCase):
    def test_kafka_tls_validates_ca_with_secure_client_context_and_retains_verification(self):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        env = {"KAFKA_REQUIRE_TLS": "true", "KAFKA_SECURITY_PROTOCOL": "SASL_SSL",
               "KAFKA_SASL_MECHANISM": "PLAIN", "KAFKA_SASL_USERNAME": "fixture",
               "KAFKA_SASL_PASSWORD": "fixture", "KAFKA_TLS_CA_FILE": "/fixture/ca.pem"}
        create = Mock(return_value=context)
        ssl_adapter = SimpleNamespace(SSLContext=create, PROTOCOL_TLS_CLIENT=ssl.PROTOCOL_TLS_CLIENT,
                                      TLSVersion=ssl.TLSVersion)
        with patch.dict("os.environ", env, clear=True), patch("risk_engine.kafka_source.ssl", ssl_adapter), patch.object(context, "load_verify_locations") as load_ca:
            config = _security_config()
        create.assert_called_once_with(ssl.PROTOCOL_TLS_CLIENT)
        load_ca.assert_called_once_with(cafile="/fixture/ca.pem")
        self.assertEqual(ssl.TLSVersion.TLSv1_2, context.minimum_version)
        self.assertEqual(ssl.CERT_REQUIRED, context.verify_mode)
        self.assertTrue(context.check_hostname)
        self.assertTrue(config["enable.ssl.certificate.verification"])
        self.assertEqual("SASL_SSL", config["security.protocol"])

    def test_kafka_tls_rejects_invalid_ca_and_incomplete_security(self):
        with tempfile.TemporaryDirectory() as directory:
            ca = Path(directory) / "invalid-ca.pem"
            ca.write_text("this is not a certificate")
            env = {"KAFKA_REQUIRE_TLS": "true", "KAFKA_SECURITY_PROTOCOL": "SASL_SSL",
                   "KAFKA_SASL_MECHANISM": "PLAIN", "KAFKA_SASL_USERNAME": "fixture",
                   "KAFKA_SASL_PASSWORD": "fixture", "KAFKA_TLS_CA_FILE": str(ca)}
            with patch.dict("os.environ", env, clear=True), self.assertRaises(ssl.SSLError):
                _security_config()
        with patch.dict("os.environ", {"KAFKA_REQUIRE_TLS": "true"}, clear=True), self.assertRaises(ValueError):
            _security_config()
        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual({}, _security_config())

    def test_route_epoch_remains_ascii_only(self):
        value = route(placementEpoch="1\u0662")
        instant = NOW.timestamp()
        with self.assertRaises(StoreError) as result:
            validate_route(value, SHARD_TENANT, instant)
        self.assertEqual("42501", result.exception.sqlstate)

    def test_bad_registry_entry_allocates_no_database(self):
        registry = manifest()
        registry["shards"]["s4"]["replicaUrls"] = "not a list"
        database = Mock()
        fetch = lambda tenant: route()
        with self.assertRaises(ValueError):
            ShardedDatabase(registry, fetch, allow_loopback=True, database=database)
        database.assert_not_called()


class ScoringPolicyRegressionTest(unittest.TestCase):
    def test_persisted_uncalibrated_policy_retains_v2_provenance_and_identity(self):
        scenario = Scenario(self)
        scenario.setup_wheat_then_canola()
        selected = policy(tenant_id=scenario.tenant, effective_from=NOW - timedelta(days=3))
        reading = scenario.reading("2026-09-24T11:00:00Z")
        with patch.object(FakeTx, "select_policy", create=True, return_value=selected):
            result = scenario.apply(reading)
        self.assertEqual(APPLIED, result.outcome)
        expected_ids = deterministic_ids(scenario.tenant, reading["event_id"], scenario.wheat,
                                         selected.version, selected.policy_id)
        actual_ids = (result.event_id, result.assessment_id)
        self.assertEqual(expected_ids, actual_ids)
        event = scenario.db.state["outbox"][-1]
        self.assertEqual(2, event["schema_version"])
        self.assertFalse(event["payload"]["policy_calibrated"])
        self.assertEqual("insufficient_data", event["payload"]["severity"])
        self.assertEqual(["policy_not_calibrated"], event["payload"]["reasons"])
        self.assertFalse(event["payload"]["alert_eligible"])
        self.assertEqual("draft", event["payload"]["policy_provenance"]["status"])

    def test_missing_or_invalid_persisted_policy_rolls_back_inbox_and_outbox(self):
        for selected in (None, policy(calibrated=True, measurement_thresholds={})):
            scenario = Scenario(self)
            scenario.setup_wheat_then_canola()
            before_inbox = len(scenario.db.state["inbox"])
            before_outbox = len(scenario.db.state["outbox"])
            reading = scenario.reading("2026-09-24T11:00:00Z")
            with self.subTest(selected=selected), patch.object(FakeTx, "select_policy", create=True, return_value=selected):
                result = scenario.apply(reading)
            self.assertEqual((QUARANTINE, "policy_unavailable"), (result.outcome, result.reason))
            self.assertEqual(before_inbox, len(scenario.db.state["inbox"]))
            self.assertEqual(before_outbox, len(scenario.db.state["outbox"]))
            self.assertEqual({}, scenario.db.state["assessments"])

    def test_legacy_assessment_fallback_returns_duplicate_without_new_outbox(self):
        scenario = Scenario(self)
        scenario.setup_wheat_then_canola()
        selected = policy(tenant_id=scenario.tenant)
        previous = {"event_id": "previous-event", "assessment_id": "previous-assessment"}
        reading = scenario.reading("2026-09-24T11:00:00Z")
        before_outbox = len(scenario.db.state["outbox"])
        with patch.object(FakeTx, "select_policy", create=True, return_value=selected), patch.object(FakeTx, "legacy_assessment", create=True, return_value=previous) as legacy:
            result = scenario.apply(reading)
        legacy.assert_called_once_with(reading["event_id"], scenario.wheat, selected.version)
        self.assertEqual((DUPLICATE, "previous-event", "previous-assessment"), (result.outcome, result.event_id, result.assessment_id))
        self.assertEqual(before_outbox, len(scenario.db.state["outbox"]))
        self.assertEqual({}, scenario.db.state["assessments"])
