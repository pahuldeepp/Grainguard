import unittest
from unittest.mock import Mock, patch
import uuid

from ml_scoring.store import _PostgresTransaction


TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


class PostgresClaimTests(unittest.TestCase):
    def test_claim_uses_one_bounded_tenant_filtered_statement_and_returns_rows(self):
        connection = Mock()
        event_id = uuid.UUID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
        payload = {"event_id": str(event_id)}
        connection.execute.return_value.fetchall.return_value = [(event_id, payload)]
        token = uuid.UUID("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
        with patch("ml_scoring.store.uuid.uuid4", return_value=token):
            claimed_token, rows = _PostgresTransaction(connection, TENANT).claim_pending_shadow_events(25, 60)
        self.assertEqual(claimed_token, str(token))
        self.assertEqual(rows, [{"event_id": str(event_id), "payload": payload}])
        connection.execute.assert_called_once()
        query, params = connection.execute.call_args.args
        self.assertEqual(params, (TENANT, 25, str(token), 60, TENANT))
        self.assertIn("LIMIT %s FOR UPDATE SKIP LOCKED", query)
        self.assertIn("WHERE tenant_id=%s AND published_at IS NULL", query)
        self.assertIn("WHERE outbox.tenant_id=%s", query)
        self.assertIn("RETURNING outbox.event_id, outbox.payload, outbox.created_at", query)
        self.assertIn("SELECT event_id, payload FROM claimed ORDER BY created_at, event_id", query)

    def test_invalid_bounds_never_execute_a_claim(self):
        connection = Mock()
        transaction = _PostgresTransaction(connection, TENANT)
        for limit, seconds in ((0, 60), (101, 60), (1, 0)):
            with self.subTest(limit=limit, seconds=seconds), self.assertRaises(ValueError):
                transaction.claim_pending_shadow_events(limit, seconds)
        connection.execute.assert_not_called()


if __name__ == "__main__":
    unittest.main()
