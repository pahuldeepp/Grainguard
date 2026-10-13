from datetime import datetime, timezone
import unittest

from knowledge_extensions.service import KnowledgeRagService


TENANT = "11111111-1111-4111-8111-111111111111"
KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


class FakeConnection:
    def __init__(self, store):
        self.store = store
        self.row = None
        self.tenant = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def transaction(self):
        return self

    def execute(self, query, params=()):
        if "set_config('app.tenant_id'" in query:
            self.tenant = params[0]
            self.store["tenant_contexts"].append(self.tenant)
            return self
        self.store["queries"].append(query)
        if query.lstrip().startswith("INSERT INTO assistant_suggestion_usage_outbox"):
            tenant, event_id, suggestion_id = params
            assert tenant == self.tenant
            if (tenant, event_id) in self.store["rows"]:
                self.row = None
            else:
                row = (event_id, suggestion_id, datetime(2026, 1, 1, tzinfo=timezone.utc))
                self.store["rows"][(tenant, event_id)] = row
                self.row = row
            return self
        if "FROM assistant_suggestion_usage_outbox" in query:
            tenant, event_id = params
            assert tenant == self.tenant
            self.row = self.store["rows"].get((tenant, event_id))
            return self
        raise AssertionError("unexpected database query")

    def fetchone(self):
        return self.row


class SuggestionUsageTests(unittest.TestCase):
    def service(self):
        store = {"rows": {}, "queries": [], "tenant_contexts": []}
        service = KnowledgeRagService.__new__(KnowledgeRagService)
        service._connect = lambda: FakeConnection(store)
        return service, store

    def test_usage_insert_is_idempotent_and_stores_only_allowed_event_fields(self):
        service, store = self.service()
        first = service.record_suggestion_usage(tenant_id=TENANT, suggestion_id="grain_moisture", idempotency_key=KEY)
        retry = service.record_suggestion_usage(tenant_id=TENANT, suggestion_id="grain_moisture", idempotency_key=KEY)
        self.assertFalse(first["idempotent"])
        self.assertTrue(retry["idempotent"])
        self.assertEqual(first["event_id"], retry["event_id"])
        self.assertEqual(len(store["rows"]), 1)
        self.assertEqual(store["tenant_contexts"], [TENANT, TENANT])
        self.assertTrue(all("principal" not in query and "question" not in query for query in store["queries"]))

    def test_reusing_idempotency_key_for_different_suggestion_fails_closed(self):
        service, _ = self.service()
        service.record_suggestion_usage(tenant_id=TENANT, suggestion_id="grain_moisture", idempotency_key=KEY)
        with self.assertRaisesRegex(ValueError, "another suggestion"):
            service.record_suggestion_usage(tenant_id=TENANT, suggestion_id="mold_risk", idempotency_key=KEY)

    def test_rls_makes_idempotency_tenant_scoped(self):
        service, store = self.service()
        other = "99999999-9999-4999-8999-999999999999"
        a = service.record_suggestion_usage(tenant_id=TENANT, suggestion_id="storage_checks", idempotency_key=KEY)
        b = service.record_suggestion_usage(tenant_id=other, suggestion_id="storage_checks", idempotency_key=KEY)
        self.assertEqual(a["event_id"], b["event_id"])
        self.assertFalse(a["idempotent"])
        self.assertFalse(b["idempotent"])
        self.assertEqual(len(store["rows"]), 2)


if __name__ == "__main__":
    unittest.main()
