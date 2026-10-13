import unittest
from contextlib import contextmanager

from knowledge_extensions.conversation_retention import purge_expired_deleted_conversations


class Cursor:
    def __init__(self, rows=()):
        self.rows = list(rows)

    def fetchall(self):
        return self.rows


class FakeConnection:
    def __init__(self):
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    @contextmanager
    def transaction(self):
        yield

    def execute(self, query, params=()):
        self.calls.append((query, params))
        return Cursor([("conversation-id",)] if "DELETE FROM assistant_conversations" in query else [])


class ConversationRetentionTests(unittest.TestCase):
    def test_scoped_expired_soft_deleted_rows_are_purged_in_bounded_batches(self):
        connection = FakeConnection()
        purged = purge_expired_deleted_conversations(
            lambda: connection,
            scopes=[{"tenant_id": "tenant-a", "user_id": "user-a"}],
            retention_days=30, batch_size=7,
        )
        self.assertEqual(purged, 1)
        delete_query, params = next((query, params) for query, params in connection.calls
                                   if "DELETE FROM assistant_conversations" in query)
        self.assertIn("deleted_at < clock_timestamp()", delete_query)
        self.assertIn("deleted_at IS NOT NULL", delete_query)
        self.assertIn("LIMIT %s FOR UPDATE SKIP LOCKED", delete_query)
        self.assertEqual(params, ("tenant-a", "user-a", 30, 7))
        self.assertEqual(connection.calls[0][1], ("tenant-a",))
        self.assertEqual(connection.calls[1][1], ("user-a",))

    def test_rejects_unbounded_or_empty_configuration(self):
        for kwargs in (
            {"scopes": [], "retention_days": 30, "batch_size": 10},
            {"scopes": [{"tenant_id": "t", "user_id": "u"}], "retention_days": 0, "batch_size": 10},
            {"scopes": [{"tenant_id": "t", "user_id": "u"}], "retention_days": 30, "batch_size": 0},
        ):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                purge_expired_deleted_conversations(lambda: FakeConnection(), **kwargs)


if __name__ == "__main__":
    unittest.main()
