import unittest
from contextlib import contextmanager

from knowledge_extensions.outline import ParsedBlock, build_outline
from knowledge_extensions.outline_store import (
    OutlineVersionConflict, delete_outline, save_outline,
)


TENANT = "11111111-1111-4111-8111-111111111111"
DOC = "33333333-3333-4333-8333-333333333333"
CHUNK = "44444444-4444-4444-8444-444444444444"
HASH_1 = "a" * 64
HASH_2 = "b" * 64


class FakeCursor:
    def __init__(self, row=None):
        self.row = row

    def fetchone(self):
        return self.row


class FakeConnection:
    def __init__(self, current=None):
        self.outlines = ({current[0]: current} if current else {})
        self.calls = []
        self.fail = False

    @contextmanager
    def transaction(self):
        start = len(self.calls)
        previous = dict(self.outlines)
        try:
            yield
            if self.fail:
                raise RuntimeError("simulated insert failure")
        except BaseException:
            del self.calls[start:]
            self.outlines = previous
            raise

    def execute(self, query, params=()):
        self.calls.append((query, params))
        if "SELECT document_version, source_sha256" in query:
            return FakeCursor(self.outlines.get(params[2]))
        if "INSERT INTO knowledge_document_outlines" in query:
            self.outlines.setdefault(params[2], (params[2], params[3]))
        return FakeCursor()


def outline(version=1):
    return build_outline(
        tenant_id=TENANT, document_id=DOC, document_version=version,
        blocks=[
            ParsedBlock("heading", "Storage", 1, 1, heading_level=1),
            ParsedBlock("chunk", "Synthetic text", 2, 2, chunk_id=CHUNK),
        ],
    )


class OutlineStoreTests(unittest.TestCase):
    def test_save_sets_tenant_context_and_atomically_writes_versioned_rows(self):
        db = FakeConnection()
        save_outline(db, tenant_id=TENANT, outline=outline(), source_sha256=HASH_1)
        self.assertIn(("SELECT set_config('app.tenant_id', %s, true)", (TENANT,)), db.calls)
        sql = [call[0] for call in db.calls]
        self.assertTrue(any("INSERT INTO knowledge_outline_nodes" in statement for statement in sql))
        self.assertTrue(any("INSERT INTO knowledge_outline_chunks" in statement for statement in sql))
        self.assertEqual(db.outlines[1], (1, HASH_1))

    def test_newer_version_replaces_old_and_stale_or_conflicting_results_fail(self):
        db = FakeConnection((1, HASH_1))
        save_outline(db, tenant_id=TENANT, outline=outline(2), source_sha256=HASH_2)
        self.assertEqual(db.outlines[2], (2, HASH_2))
        before = len(db.calls)
        save_outline(db, tenant_id=TENANT, outline=outline(1), source_sha256=HASH_1)
        self.assertGreater(len(db.calls), before)
        with self.assertRaises(OutlineVersionConflict):
            save_outline(db, tenant_id=TENANT, outline=outline(2), source_sha256=HASH_1)

    def test_wrong_tenant_bad_hash_and_failed_transaction_do_not_write(self):
        db = FakeConnection()
        with self.assertRaises(ValueError):
            save_outline(db, tenant_id=TENANT, outline=outline(), source_sha256="bad")
        with self.assertRaises(ValueError):
            save_outline(db, tenant_id="22222222-2222-4222-8222-222222222222",
                         outline=outline(), source_sha256=HASH_1)
        db.fail = True
        with self.assertRaises(RuntimeError):
            save_outline(db, tenant_id=TENANT, outline=outline(), source_sha256=HASH_1)
        self.assertEqual(db.calls, [])
        self.assertEqual(db.outlines, {})

    def test_delete_runs_inside_tenant_transaction(self):
        db = FakeConnection()
        delete_outline(db, tenant_id=TENANT, document_id=DOC)
        self.assertEqual(db.calls[0], ("SELECT set_config('app.tenant_id', %s, true)", (TENANT,)))
        self.assertIn("DELETE FROM knowledge_document_outlines", db.calls[1][0])


if __name__ == "__main__":
    unittest.main()
