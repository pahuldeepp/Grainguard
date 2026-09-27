import json
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parent / "lambda"))

from botocore.exceptions import ClientError, ParamValidationError

import escalation_mirror
import notification_dispatch

TENANT = "11111111-1111-4111-8111-111111111111"
EPISODE = "22222222-2222-4222-8222-222222222222"
EVENT = "33333333-3333-4333-8333-333333333333"


def detail(event_type="alert.escalated", version="3", state="open", transport_type=None):
    return {
        "source": "greenguard.alerts",
        "detail-type": transport_type or event_type,
        "detail": {
            "event_id": EVENT,
            "correlation_id": "44444444-4444-4444-8444-444444444444",
            "causation_id": "55555555-5555-4555-8555-555555555555",
            "traceparent": "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
            "event_type": event_type,
            "schema_version": 1,
            "tenant_id": TENANT,
            "aggregate_type": "alert_episode",
            "aggregate_id": EPISODE,
            "aggregate_version": version,
            "payload": {
                "episode_id": EPISODE,
                "episode_version": version,
                "state": state,
                "severity": "critical",
                "escalation_level": 1,
                "transition_at": "2026-09-25T12:00:00Z",
            },
        },
    }


class ConditionalWriteTests(unittest.TestCase):
    def test_mirror_is_tenant_partitioned_and_version_fenced(self):
        table = Mock()
        self.assertTrue(escalation_mirror.apply_event(table, detail()))
        kwargs = table.put_item.call_args.kwargs
        self.assertEqual(kwargs["Item"]["tenant_id"], TENANT)
        self.assertEqual(kwargs["Item"]["episode_id"], EPISODE)
        self.assertEqual(kwargs["Item"]["episode_version"], 3)
        self.assertIn("episode_version < :version", kwargs["ConditionExpression"])
        self.assertNotIn("email", kwargs["Item"])

    def test_replay_or_older_version_is_an_idempotent_noop(self):
        table = Mock()
        table.put_item.side_effect = ClientError(
            {"Error": {"Code": "ConditionalCheckFailedException"}}, "PutItem"
        )
        self.assertFalse(escalation_mirror.apply_event(table, detail(version="2")))

    def test_mirror_rejects_tenant_or_aggregate_mismatch(self):
        event = detail()
        event["detail"]["payload"]["episode_id"] = "44444444-4444-4444-8444-444444444444"
        with self.assertRaisesRegex(ValueError, "invalid alert lifecycle detail"):
            escalation_mirror.apply_event(Mock(), event)

    def test_mirror_rejects_noncanonical_source_and_type(self):
        event = detail(transport_type="alert.critical.serverless")
        event["source"] = "other.service"
        with self.assertRaisesRegex(ValueError, "unexpected alert event source"):
            escalation_mirror.apply_event(Mock(), event)


class NotificationDispatchTests(unittest.TestCase):
    def setUp(self):
        notification_dispatch._aws_clients.cache_clear()
        self.addCleanup(notification_dispatch._aws_clients.cache_clear)

    def test_warm_handlers_reuse_clients_with_existing_provider_timeouts(self):
        table, ses, sns = self.Table(), Mock(), Mock()
        resource = Mock(Table=Mock(return_value=table))
        with (patch.dict(notification_dispatch.os.environ, {"NOTIFICATION_STATE_TABLE": "state", "SES_FROM_EMAIL": "verified@example.test"}),
              patch.object(notification_dispatch.boto3, "resource", return_value=resource) as resource_factory,
              patch.object(notification_dispatch.boto3, "client", side_effect=[ses, sns]) as client_factory):
            record = {"messageId": "ok", "body": json.dumps(detail(transport_type="alert.critical.serverless"))}
            for _ in range(2):
                self.assertEqual(notification_dispatch.handler({"Records": [record]}, None), {"batchItemFailures": []})
        resource_factory.assert_called_once_with("dynamodb")
        resource.Table.assert_called_once_with("state")
        self.assertEqual([call.args for call in client_factory.call_args_list], [("ses",), ("sns",)])
        for call in client_factory.call_args_list:
            config = call.kwargs["config"]
            self.assertEqual((config.connect_timeout, config.read_timeout), (3, 8))
            self.assertEqual(config.retries, {"total_max_attempts": 1})
        ses.send_email.assert_called_once()
        sns.publish.assert_called_once()

    def test_client_cache_can_be_reset_for_independent_fake_factories(self):
        first, second = (Mock(), Mock(), Mock()), (Mock(), Mock(), Mock())
        with patch.dict(notification_dispatch.os.environ, {"NOTIFICATION_STATE_TABLE": "state"}):
            for clients in (first, second):
                notification_dispatch._aws_clients.cache_clear()
                with (patch.object(notification_dispatch.boto3, "resource", return_value=Mock(Table=Mock(return_value=clients[0]))),
                      patch.object(notification_dispatch.boto3, "client", side_effect=clients[1:])):
                    self.assertEqual(notification_dispatch._aws_clients(), clients)
                    self.assertEqual(notification_dispatch._aws_clients(), clients)
        self.assertEqual(notification_dispatch._aws_clients(), second)

    class Table:
        def __init__(self, contacts="default"):
            self.items = {}
            self.reads = []
            self.checkpoint = {**notification_dispatch._FEED_KEY, "source_time_ms": notification_dispatch.time.time_ns() // 1_000_000}
            self.contacts = {"tenant_id": TENANT, "record_key": "CONTACTS", "email": "alerts@example.test", "sms": "+12045550123", "version": __import__("decimal").Decimal("9223372036854775807")} if contacts == "default" else contacts
        def get_item(self, **kwargs):
            self.reads.append(kwargs)
            key = kwargs["Key"]
            if key == notification_dispatch._FEED_KEY:
                return {"Item": self.checkpoint} if self.checkpoint else {}
            self.assert_tenant(key["tenant_id"])
            if key["record_key"] == "CONTACTS":
                return {"Item": self.contacts} if self.contacts else {}
            item = self.items.get((key["tenant_id"], key["record_key"]))
            return {"Item": item} if item else {}
        def assert_tenant(self, tenant):
            if tenant != TENANT: raise AssertionError("unexpected tenant query")
        def put_item(self, *, Item, ConditionExpression):
            key = (Item["tenant_id"], Item["record_key"])
            if key in self.items:
                raise ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "PutItem")
            self.items[key] = dict(Item)
        def update_item(self, *, Key, UpdateExpression, ConditionExpression, ExpressionAttributeNames, ExpressionAttributeValues):
            item = self.items[(Key["tenant_id"], Key["record_key"])]
            if item["status"] != ExpressionAttributeValues[":started"]:
                raise ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")
            item["status"] = ExpressionAttributeValues[":status"]
            item["reason"] = ExpressionAttributeValues.get(":reason")

    def test_feed_checkpoint_freshness_rejects_before_contact_claim_or_send(self):
        now_ms = 1_800_000_000_000
        record = {"body": json.dumps(detail(transport_type="alert.critical.serverless"))}
        invalid = [None, {},
                   {**notification_dispatch._FEED_KEY, "source_time_ms": now_ms - 60_001},
                   {**notification_dispatch._FEED_KEY, "source_time_ms": now_ms + 5_001},
                   {**notification_dispatch._FEED_KEY, "source_time_ms": True},
                   {**notification_dispatch._FEED_KEY, "source_time_ms": "NaN"},
                   {**notification_dispatch._FEED_KEY, "source_time_ms": now_ms, "tenant_id": TENANT}]
        for checkpoint in invalid:
            with self.subTest(checkpoint=checkpoint):
                table, ses, sns = self.Table(), Mock(), Mock()
                table.checkpoint = checkpoint
                with patch.object(notification_dispatch.time, "time_ns", return_value=now_ms * 1_000_000):
                    with self.assertRaisesRegex(RuntimeError, "checkpoint"):
                        notification_dispatch.dispatch_one(record, table=table, ses=ses, sns=sns)
                self.assertEqual(table.reads, [{"Key": notification_dispatch._FEED_KEY, "ConsistentRead": True}])
                self.assertEqual(table.items, {})
                ses.send_email.assert_not_called()
                sns.publish.assert_not_called()

    def test_fresh_checkpoint_accepts_threshold_and_clock_skew_without_aging_contacts(self):
        now_ms = 1_800_000_000_000
        record = {"body": json.dumps(detail(transport_type="alert.critical.serverless"))}
        for source_ms in [now_ms, now_ms - 60_000, now_ms + 5_000]:
            with self.subTest(source_ms=source_ms):
                table, ses, sns = self.Table(), Mock(), Mock()
                table.checkpoint["source_time_ms"] = __import__("decimal").Decimal(source_ms)
                with (patch.object(notification_dispatch.time, "time_ns", return_value=now_ms * 1_000_000),
                      patch.dict(notification_dispatch.os.environ, {"SES_FROM_EMAIL": "verified@example.test"})):
                    self.assertEqual(notification_dispatch.dispatch_one(record, table=table, ses=ses, sns=sns), ["accepted", "accepted"])
                self.assertEqual(table.reads[0], {"Key": notification_dispatch._FEED_KEY, "ConsistentRead": True})
                ses.send_email.assert_called_once()
                sns.publish.assert_called_once()

    def test_feed_becoming_stale_between_channels_does_not_claim_or_send_second_channel(self):
        now_ms = 1_800_000_000_000
        table, ses, sns = self.Table(), Mock(), Mock()
        table.checkpoint["source_time_ms"] = now_ms - 59_999
        record = {"body": json.dumps(detail(transport_type="alert.critical.serverless"))}
        with (patch.object(notification_dispatch.time, "time_ns", side_effect=[now_ms * 1_000_000, now_ms * 1_000_000, (now_ms + 2) * 1_000_000]),
              patch.dict(notification_dispatch.os.environ, {"SES_FROM_EMAIL": "verified@example.test"})):
            with self.assertRaisesRegex(RuntimeError, "checkpoint stale"):
                notification_dispatch.dispatch_one(record, table=table, ses=ses, sns=sns)
        ses.send_email.assert_called_once()
        sns.publish.assert_not_called()
        self.assertEqual(len(table.items), 1)
        self.assertEqual(next(iter(table.items.values()))["status"], "ACCEPTED")

    def test_missing_feed_checkpoint_returns_sqs_retry_without_claiming_or_sending(self):
        table, ses, sns = self.Table(), Mock(), Mock()
        table.checkpoint = None
        with (patch.dict(notification_dispatch.os.environ, {"NOTIFICATION_STATE_TABLE": "state"}),
              patch.object(notification_dispatch.boto3, "resource", return_value=Mock(Table=Mock(return_value=table))),
              patch.object(notification_dispatch.boto3, "client", side_effect=[ses, sns]),
              patch("builtins.print") as log):
            result = notification_dispatch.handler({"Records": [{"messageId": "retry", "body": json.dumps(detail(transport_type="alert.critical.serverless"))}]}, None)
        self.assertEqual(result, {"batchItemFailures": [{"itemIdentifier": "retry"}]})
        self.assertEqual(table.items, {})
        ses.send_email.assert_not_called()
        sns.publish.assert_not_called()
        self.assertNotIn("alerts@example.test", str(log.call_args_list))

    def test_direct_provider_send_is_tenant_scoped_idempotent_and_version_exact(self):
        table, ses, sns = self.Table(), Mock(), Mock()
        record = {"body": json.dumps(detail(transport_type="alert.critical.serverless"))}
        with patch.dict(notification_dispatch.os.environ, {"SES_FROM_EMAIL": "verified@example.test"}):
            self.assertEqual(notification_dispatch.dispatch_one(record, table=table, ses=ses, sns=sns), ["accepted", "accepted"])
            self.assertEqual(notification_dispatch.dispatch_one(record, table=table, ses=ses, sns=sns), ["duplicate", "duplicate"])
        ses.send_email.assert_called_once()
        sns.publish.assert_called_once()
        items = list(table.items.values())
        self.assertEqual({item["contact_version"] for item in items}, {__import__("decimal").Decimal("9223372036854775807")})
        self.assertEqual({item["status"] for item in items}, {"ACCEPTED"})
        self.assertEqual({item["intent_id"] for item in items}, {
            notification_dispatch.stable_intent_id(TENANT, EPISODE, 3, "email"),
            notification_dispatch.stable_intent_id(TENANT, EPISODE, 3, "sms"),
        })

    def test_critical_resolved_sends_email_and_sms_and_replays_do_not_send(self):
        event = detail(event_type="alert.resolved", state="resolved", transport_type="alert.critical.serverless")
        table, ses, sns = self.Table(), Mock(), Mock()
        record = {"body": json.dumps(event)}
        with patch.dict(notification_dispatch.os.environ, {"SES_FROM_EMAIL": "verified@example.test"}):
            notification_dispatch.dispatch_one(record, table=table, ses=ses, sns=sns)
            notification_dispatch.dispatch_one(record, table=table, ses=ses, sns=sns)
        ses.send_email.assert_called_once()
        sns.publish.assert_called_once()

    def test_contact_projection_tenant_identity_must_match_authenticated_event_key(self):
        table = self.Table()
        table.contacts["tenant_id"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        with self.assertRaisesRegex(RuntimeError, "mismatched"):
            notification_dispatch.dispatch_one({"body": json.dumps(detail(transport_type="alert.critical.serverless"))}, table=table, ses=Mock(), sns=Mock())

    def test_missing_contact_projection_retries_without_external_fallback(self):
        table, ses, sns = self.Table(contacts=None), Mock(), Mock()
        with self.assertRaisesRegex(RuntimeError, "projection is missing"):
            notification_dispatch.dispatch_one({"body": json.dumps(detail(transport_type="alert.critical.serverless"))}, table=table, ses=ses, sns=sns)
        ses.send_email.assert_not_called()
        sns.publish.assert_not_called()

    def test_contactless_channel_is_suppressed_and_provider_ambiguity_is_not_retried(self):
        table = self.Table(contacts={"tenant_id": TENANT, "record_key": "CONTACTS", "email": None, "sms": "+12045550123", "version": __import__("decimal").Decimal("9")})
        ses, sns = Mock(), Mock()
        sns.publish.side_effect = TimeoutError("ambiguous after provider may accept")
        record = {"body": json.dumps(detail(transport_type="alert.critical.serverless"))}
        with self.assertRaisesRegex(RuntimeError, "operator review"): notification_dispatch.dispatch_one(record, table=table, ses=ses, sns=sns)
        for _ in range(3):
            with self.assertRaisesRegex(RuntimeError, "operator review"):
                notification_dispatch.dispatch_one(record, table=table, ses=ses, sns=sns)
        self.assertEqual(sns.publish.call_count, 1)
        self.assertFalse(ses.send_email.called)
        statuses = {item["status"] for item in table.items.values()}
        self.assertEqual(statuses, {"SUPPRESSED", "UNKNOWN"})

    def test_definitive_provider_rejection_is_persisted_without_resend(self):
        table, ses, sns = self.Table(), Mock(), Mock()
        ses.send_email.side_effect = ClientError({"Error": {"Code": "MessageRejected"}}, "SendEmail")
        record = {"body": json.dumps(detail(transport_type="alert.critical.serverless"))}
        with patch.dict(notification_dispatch.os.environ, {"SES_FROM_EMAIL": "verified@example.test"}):
            for _ in range(2):
                with self.assertRaisesRegex(RuntimeError, "operator review"):
                    notification_dispatch.dispatch_one(record, table=table, ses=ses, sns=sns)
        self.assertEqual(ses.send_email.call_count, 1)
        statuses = {item["status"] for item in table.items.values()}
        self.assertEqual(statuses, {"REJECTED", "ACCEPTED"})

    def test_sdk_parameter_validation_rejects_without_resend_and_other_channel_proceeds(self):
        record = {"body": json.dumps(detail(transport_type="alert.critical.serverless"))}
        for failed_channel in ("email", "sms"):
            with self.subTest(failed_channel=failed_channel):
                table, ses, sns = self.Table(), Mock(), Mock()
                failure = ParamValidationError(
                    report=f"invalid destination alerts@example.test tenant={TENANT}"
                )
                if failed_channel == "email":
                    ses.send_email.side_effect = failure
                else:
                    sns.publish.side_effect = failure
                with patch.dict(notification_dispatch.os.environ, {"SES_FROM_EMAIL": "verified@example.test"}):
                    for _ in range(2):
                        with self.assertRaisesRegex(RuntimeError, "operator review"):
                            notification_dispatch.dispatch_one(record, table=table, ses=ses, sns=sns)
                ses.send_email.assert_called_once()
                sns.publish.assert_called_once()
                by_channel = {item["channel"]: item for item in table.items.values()}
                self.assertEqual(by_channel[failed_channel]["status"], "REJECTED")
                self.assertEqual(by_channel[failed_channel]["reason"], "ParamValidationError")
                self.assertEqual(by_channel["sms" if failed_channel == "email" else "email"]["status"], "ACCEPTED")
                self.assertNotIn("alerts@example.test", str(table.items))

    def test_accepted_email_finish_failure_still_sends_sms_and_never_resends_email(self):
        email_id = notification_dispatch.stable_intent_id(TENANT, EPISODE, 3, "email")

        class FailingEmailFinish(self.Table):
            def update_item(self, **kwargs):
                if kwargs["Key"]["record_key"] == f"DELIVERY#{email_id}":
                    raise ClientError({"Error": {"Code": "InternalServerError"}}, "UpdateItem")
                return super().update_item(**kwargs)

        table, ses, sns = FailingEmailFinish(), Mock(), Mock()
        record = {"body": json.dumps(detail(transport_type="alert.critical.serverless"))}
        with patch.dict(notification_dispatch.os.environ, {"SES_FROM_EMAIL": "verified@example.test"}):
            for _ in range(2):
                with self.assertRaisesRegex(RuntimeError, "operator review"):
                    notification_dispatch.dispatch_one(record, table=table, ses=ses, sns=sns)
        ses.send_email.assert_called_once()
        sns.publish.assert_called_once()
        self.assertEqual({item["channel"]: item["status"] for item in table.items.values()},
                         {"email": "UNKNOWN", "sms": "ACCEPTED"})

    def test_outcome_failure_diagnostic_exposes_type_without_sensitive_data(self):
        table = Mock()
        table.update_item.side_effect = TimeoutError(
            f"tenant={TENANT} destination=alerts@example.test provider=secret-response"
        )
        with patch("builtins.print") as logged:
            self.assertFalse(notification_dispatch._record_outcome(
                table, tenant=TENANT, intent_id="sensitive-intent", channel="email",
                status="ACCEPTED", reason="sensitive-reason",
            ))
        logged.assert_called_once()
        diagnostic = logged.call_args.args[0]
        self.assertEqual(json.loads(diagnostic), {
            "level": "error", "component": "notification_dispatch",
            "phase": "outcome_persist", "channel": "email", "error": "TimeoutError",
        })
        for sensitive in (TENANT, "alerts@example.test", "secret-response",
                          "sensitive-intent", "sensitive-reason"):
            self.assertNotIn(sensitive, diagnostic)

    def test_rejected_email_finish_failure_does_not_mask_sms(self):
        email_id = notification_dispatch.stable_intent_id(TENANT, EPISODE, 3, "email")

        class FailingEmailFinish(self.Table):
            def update_item(self, **kwargs):
                if kwargs["Key"]["record_key"] == f"DELIVERY#{email_id}":
                    raise TimeoutError("DynamoDB outcome may or may not have persisted")
                return super().update_item(**kwargs)

        table, ses, sns = FailingEmailFinish(), Mock(), Mock()
        ses.send_email.side_effect = ClientError({"Error": {"Code": "MessageRejected"}}, "SendEmail")
        record = {"body": json.dumps(detail(transport_type="alert.critical.serverless"))}
        with patch.dict(notification_dispatch.os.environ, {"SES_FROM_EMAIL": "verified@example.test"}):
            with self.assertRaisesRegex(RuntimeError, "operator review"):
                notification_dispatch.dispatch_one(record, table=table, ses=ses, sns=sns)
        ses.send_email.assert_called_once()
        sns.publish.assert_called_once()
        self.assertEqual({item["channel"]: item["status"] for item in table.items.values()},
                         {"email": "UNKNOWN", "sms": "ACCEPTED"})

    def test_missing_email_finish_failure_still_sends_sms(self):
        email_id = notification_dispatch.stable_intent_id(TENANT, EPISODE, 3, "email")

        class FailingEmailFinish(self.Table):
            def update_item(self, **kwargs):
                if kwargs["Key"]["record_key"] == f"DELIVERY#{email_id}":
                    raise TimeoutError("DynamoDB update interrupted")
                return super().update_item(**kwargs)

        table, ses, sns = FailingEmailFinish(), Mock(), Mock()
        table.contacts["email"] = None
        record = {"body": json.dumps(detail(transport_type="alert.critical.serverless"))}
        with self.assertRaisesRegex(RuntimeError, "operator review"):
            notification_dispatch.dispatch_one(record, table=table, ses=ses, sns=sns)
        ses.send_email.assert_not_called()
        sns.publish.assert_called_once()
        self.assertEqual({item["channel"]: item["status"] for item in table.items.values()},
                         {"email": "UNKNOWN", "sms": "ACCEPTED"})

    def test_unknown_missing_email_claim_does_not_block_sms_and_keeps_sqs_retrying(self):
        table = self.Table()
        table.contacts["email"] = None
        email_id = notification_dispatch.stable_intent_id(TENANT, EPISODE, 3, "email")
        table.items[(TENANT, f"DELIVERY#{email_id}")] = {
            "tenant_id": TENANT, "record_key": f"DELIVERY#{email_id}",
            "intent_id": email_id, "channel": "email", "status": "UNKNOWN", "reason": "send_started",
        }
        ses, sns = Mock(), Mock()
        record = {"messageId": "retry", "body": json.dumps(detail(transport_type="alert.critical.serverless"))}
        with (patch.dict(notification_dispatch.os.environ, {"NOTIFICATION_STATE_TABLE": "state"}),
              patch.object(notification_dispatch.boto3, "resource", return_value=Mock(Table=Mock(return_value=table))),
              patch.object(notification_dispatch.boto3, "client", side_effect=[ses, sns]),
              patch("builtins.print")):
            for _ in range(2):
                self.assertEqual(notification_dispatch.handler({"Records": [record]}, None),
                                 {"batchItemFailures": [{"itemIdentifier": "retry"}]})
        ses.send_email.assert_not_called()
        sns.publish.assert_called_once()
        self.assertEqual({item["channel"]: item["status"] for item in table.items.values()},
                         {"email": "UNKNOWN", "sms": "ACCEPTED"})

    def test_invalid_envelope_and_noncritical_routes_are_rejected(self):
        for envelope in (detail(transport_type="alert.updated"), {"source": "other", "detail-type": "alert.critical.serverless", "detail": {}}):
            with self.assertRaises(ValueError):
                notification_dispatch.dispatch_one({"body": json.dumps(envelope)}, table=self.Table(), ses=Mock(), sns=Mock())

    def test_sqs_batch_returns_only_failed_records_and_does_not_log_body(self):
        good = detail(transport_type="alert.critical.serverless")
        bad = {"source": "other", "detail-type": "alert.critical.serverless", "detail": {}}
        table, ses, sns = self.Table(), Mock(), Mock()
        with (patch.dict(notification_dispatch.os.environ, {"NOTIFICATION_STATE_TABLE": "state", "SES_FROM_EMAIL": "verified@example.test"}),
              patch.object(notification_dispatch.boto3, "resource", return_value=Mock(Table=Mock(return_value=table))),
              patch.object(notification_dispatch.boto3, "client", side_effect=[ses, sns]),
              patch("builtins.print") as log):
            result = notification_dispatch.handler({"Records": [{"messageId": "ok", "body": json.dumps(good)}, {"messageId": "poison", "body": json.dumps(bad)}]}, None)
        self.assertEqual(result, {"batchItemFailures": [{"itemIdentifier": "poison"}]})
        self.assertNotIn("alerts@example.test", str(log.call_args_list))

    def test_stable_intent_id_matches_jobs_worker_fixture(self):
        self.assertEqual(notification_dispatch.stable_intent_id(TENANT, EPISODE, 3, "email"), "c0df11e7-dbcb-5b03-81e5-a2693f9126b1")


if __name__ == "__main__":
    unittest.main()
