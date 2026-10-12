import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("webhook", Path(__file__).with_name("stripe-webhook-lifecycle.py"))
webhook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(webhook)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.scope = {
            "account_id": "580360261589", "region": "us-east-2", "environment": "disposable",
            "cluster": "greenguard-sandbox-cell-1",
            "secret_arn": "arn:aws:secretsmanager:us-east-2:580360261589:secret:greenguard/disposable/billing-service-config-AbCdEf",
            "seed_version": "12345678-1234-4234-8234-123456789012",
            "url": "https://d123abc.cloudfront.net/webhooks/stripe",
        }
        self.seed = {"STRIPE_API_KEY": "sk_test_SENTINEL", "BILLING_INBOX_ENCRYPTION_KEY": "private-inbox"}
        self.endpoint = {"id": "we_cell", "livemode": False, "metadata": webhook.owner(self.scope),
                         "url": self.scope["url"], "status": "enabled", "enabled_events": webhook.EVENTS,
                         "secret": "whsec_PRIVATEsigner"}

    def test_retained_signer_preserves_rotation_pair_and_rejects_invalid_lists(self):
        for raw, expected in [("whsec_old, whsec_new", "whsec_old,whsec_new"),
                              ("whsec_one", "whsec_one"), ("whsec_a,", None),
                              ("whsec_a,whsec_b,whsec_c", None), (42, None)]:
            with self.subTest(raw=raw), patch.object(webhook, "aws", return_value={"Versions": [{"VersionId": "v1"}]}), patch.object(webhook, "source", return_value={"GREENGUARD_STRIPE_WEBHOOK_ENDPOINT_ID": "we_cell", "STRIPE_WEBHOOK_SECRETS": raw}):
                self.assertEqual(webhook.retained_signer(self.scope, "we_cell"), expected)

    def test_invalid_create_cleanup_requires_proven_test_cell_ownership(self):
        for change, deleted in [({"status": "disabled"}, True), ({"livemode": True}, False), ({"metadata": {}}, False), ({"id": "malformed"}, False)]:
            with self.subTest(change=change), patch.object(webhook, "source", return_value=self.seed), patch.object(webhook, "endpoints", return_value=[]), patch.object(webhook, "stripe", return_value={**self.endpoint, **change}) as stripe:
                with self.assertRaises(RuntimeError):
                    webhook.apply(self.scope)
                self.assertEqual(any(call.args[1] == "DELETE" for call in stripe.call_args_list), deleted)

    def test_disabled_existing_replay_is_never_deleted(self):
        disabled = {**self.endpoint, "status": "disabled"}
        with patch.object(webhook, "source", return_value=self.seed), patch.object(webhook, "endpoints", return_value=[disabled]), patch.object(webhook, "retained_signer", return_value=None), patch.object(webhook, "stripe", return_value=disabled) as stripe:
            with self.assertRaises(RuntimeError):
                webhook.apply(self.scope)
            self.assertFalse(any(call.args[1] == "DELETE" for call in stripe.call_args_list))

    def test_scope_accepts_exact_cell(self):
        self.assertEqual(webhook.validate_scope(self.scope), self.scope)

    def test_scope_rejects_production_foreign_secret_and_external_urls(self):
        changes = [{"environment": "production"}, {"secret_arn": self.scope["secret_arn"].replace("580360261589", "111111111111")},
                   {"url": "https://example.com/webhooks/stripe"}, {"url": "http://d123abc.cloudfront.net/webhooks/stripe"},
                   {"url": self.scope["url"] + "?forward=other"}, {"url": "https://d123abc.cloudfront.net:443/webhooks/stripe"}]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(ValueError):
                webhook.validate_scope({**self.scope, **change})

    def test_guard_rejects_wrong_aws_account_before_remote_changes(self):
        with patch.object(webhook, "aws", return_value={"Account": "111111111111"}) as aws:
            with self.assertRaises(RuntimeError):
                webhook.guard(self.scope)
            self.assertEqual(aws.call_count, 1)

    def test_guard_rejects_foreign_ownership(self):
        with patch.object(webhook, "aws", side_effect=[{"Account": self.scope["account_id"]},
                                                     {"ARN": self.scope["secret_arn"], "Tags": []}]):
            with self.assertRaises(RuntimeError):
                webhook.guard(self.scope)

    def test_create_persists_signer_with_pinned_seed_without_output_leaks(self):
        stored = {}
        def aws(*args, payload=None):
            stored.update(json.loads(payload)); return {}
        def source(scope, version=None):
            return self.seed if version else stored
        output = io.StringIO()
        with patch.object(webhook, "source", side_effect=source), patch.object(webhook, "endpoints", return_value=[]), \
             patch.object(webhook, "stripe", return_value=self.endpoint) as stripe, patch.object(webhook, "aws", side_effect=aws), contextlib.redirect_stdout(output):
            webhook.apply(self.scope)
        self.assertEqual(stored["STRIPE_WEBHOOK_SECRETS"], self.endpoint["secret"])
        self.assertEqual(stored["GREENGUARD_STRIPE_WEBHOOK_ENDPOINT_ID"], "we_cell")
        self.assertEqual(stripe.call_args.args[2], "webhook_endpoints")
        self.assertEqual(len(stripe.call_args.args[4]), 64)
        self.assertNotIn(self.seed["STRIPE_API_KEY"], output.getvalue())
        self.assertNotIn(self.endpoint["secret"], output.getvalue())

    def test_retry_recovers_same_endpoint_and_signer(self):
        stored = {}
        def aws(*args, payload=None):
            stored.update(json.loads(payload)); return {}
        with patch.object(webhook, "source", side_effect=lambda scope, version=None: self.seed if version else stored), \
             patch.object(webhook, "endpoints", return_value=[self.endpoint]), patch.object(webhook, "retained_signer", return_value=None), \
             patch.object(webhook, "stripe", return_value=self.endpoint), patch.object(webhook, "aws", side_effect=aws), contextlib.redirect_stdout(io.StringIO()):
            webhook.apply(self.scope)
        self.assertEqual(stored["STRIPE_WEBHOOK_SECRETS"], self.endpoint["secret"])

    def test_lost_signer_never_replaces_existing_endpoint_silently(self):
        created = {**self.endpoint, "id": "we_duplicate"}
        with patch.object(webhook, "source", return_value=self.seed), patch.object(webhook, "endpoints", return_value=[self.endpoint]), \
             patch.object(webhook, "retained_signer", return_value=None), patch.object(webhook, "stripe", return_value=created) as stripe:
            with self.assertRaises(RuntimeError):
                webhook.apply(self.scope)
        self.assertEqual(stripe.call_args.args[1:3], ("DELETE", "webhook_endpoints/we_duplicate"))

    def test_existing_signer_updates_url_without_creating_second_endpoint(self):
        stored = {}
        def aws(*args, payload=None):
            stored.update(json.loads(payload)); return {}
        with patch.object(webhook, "source", side_effect=lambda scope, version=None: self.seed if version else stored), \
             patch.object(webhook, "endpoints", return_value=[self.endpoint]), patch.object(webhook, "retained_signer", return_value=self.endpoint["secret"]), \
             patch.object(webhook, "stripe", return_value=self.endpoint) as stripe, patch.object(webhook, "aws", side_effect=aws), contextlib.redirect_stdout(io.StringIO()):
            webhook.apply(self.scope)
        self.assertEqual(stripe.call_args.args[2], "webhook_endpoints/we_cell")

    def test_invalid_created_endpoint_cannot_reach_aws_secret(self):
        for change in ({"livemode": True}, {"url": "https://other.invalid/"}, {"metadata": {}}, {"secret": "bad"}):
            with self.subTest(change=change), patch.object(webhook, "source", return_value=self.seed), \
                 patch.object(webhook, "endpoints", return_value=[]), patch.object(webhook, "stripe", return_value={**self.endpoint, **change}), \
                 patch.object(webhook, "aws") as aws:
                with self.assertRaises(RuntimeError):
                    webhook.apply(self.scope)
                aws.assert_not_called()

    def test_destroy_uses_pinned_api_key_and_verifies_removal(self):
        with patch.object(webhook, "source", return_value=self.seed) as source, \
             patch.object(webhook, "endpoints", side_effect=[[self.endpoint], []]), patch.object(webhook, "stripe", return_value={"deleted": True}) as stripe, \
             contextlib.redirect_stdout(io.StringIO()):
            webhook.destroy(self.scope)
        source.assert_called_once_with(self.scope, self.scope["seed_version"])
        self.assertEqual(stripe.call_args.args[1:3], ("DELETE", "webhook_endpoints/we_cell"))

    def test_destroy_refuses_changed_url_before_any_delete(self):
        with patch.object(webhook, "source", return_value=self.seed), \
             patch.object(webhook, "endpoints", return_value=[{**self.endpoint, "url": "https://other.invalid/"}]), patch.object(webhook, "stripe") as stripe:
            with self.assertRaises(RuntimeError):
                webhook.destroy(self.scope)
            stripe.assert_not_called()

    def test_endpoint_listing_paginates_and_ignores_foreign_cells(self):
        pages = [{"data": [{"id": "we_other", "metadata": {}}, self.endpoint], "has_more": True}, {"data": [], "has_more": False}]
        with patch.object(webhook, "stripe", side_effect=pages) as stripe:
            self.assertEqual(webhook.endpoints(self.seed["STRIPE_API_KEY"], self.scope), [self.endpoint])
        self.assertIn("starting_after=we_cell", stripe.call_args.args[2])


if __name__ == "__main__":
    unittest.main()
