import unittest
from contextlib import contextmanager

from knowledge_extensions.conversation_store import (
    append_turn, create_conversation, get_conversation, list_conversations,
    soft_delete_conversation,
)


TENANT = "11111111-1111-4111-8111-111111111111"
USER = "22222222-2222-4222-8222-222222222222"
CONVERSATION = "33333333-3333-4333-8333-333333333333"
DOCUMENT = "44444444-4444-4444-8444-444444444444"
CHUNK = "55555555-5555-4555-8555-555555555555"


class Cursor:
    def __init__(self, row=None, rows=()):
        self.row = row
        self.rows = list(rows)

    def fetchone(self):
        return self.row

    def fetchall(self):
        return self.rows


class FakeConnection:
    def __init__(self, *, owned=True, fail_citation=False):
        self.calls = []
        self.messages = []
        self.citations = []
        self.owned = owned
        self.fail_citation = fail_citation

    @contextmanager
    def transaction(self):
        state = (len(self.calls), len(self.messages), len(self.citations))
        try:
            yield
        except BaseException:
            del self.calls[state[0]:]
            del self.messages[state[1]:]
            del self.citations[state[2]:]
            raise

    def execute(self, query, params=()):
        self.calls.append((query, params))
        if "SELECT title FROM assistant_conversations" in query:
            return Cursor(("New chat",) if self.owned else None)
        if "FROM assistant_conversations" in query and "SELECT conversation_id::text" in query and "AND conversation_id=%s" in query:
            return Cursor((CONVERSATION, "A question", "created", "updated", "last") if self.owned else None)
        if "FROM assistant_conversations" in query and "SELECT conversation_id::text" in query:
            return Cursor(rows=[(CONVERSATION, "A question", "created", "updated", "last")])
        if "FROM assistant_conversations" in query and "SELECT conversation_id::text" not in query and "SELECT title" not in query:
            return Cursor((CONVERSATION, "A question", "created", "updated", "last") if self.owned else None)
        if "INSERT INTO assistant_messages" in query:
            self.messages.append(params)
        if "INSERT INTO assistant_message_citations" in query:
            if self.fail_citation:
                raise RuntimeError("simulated citation insert failure")
            self.citations.append(params)
        if "RETURNING conversation_id::text" in query:
            return Cursor((params[2], params[3], "created", "updated", None))
        if "RETURNING conversation_id" in query:
            return Cursor((params[2],))
        if "FROM assistant_messages" in query and "SELECT message_id::text" in query:
            return Cursor(rows=[("66666666-6666-4666-8666-666666666666", "assistant", "answer", "model", 10, "time")])
        if "FROM assistant_message_citations" in query:
            if "message_id = ANY" in query:
                assert "message_id = ANY(%s::uuid[])" in query
            return Cursor(rows=[("66666666-6666-4666-8666-666666666666", DOCUMENT, 2, CHUNK, 4, 5, ["Storage"], "licensed", 0)])
        return Cursor()


CITATION = {
    "document_id": DOCUMENT, "document_version": 2, "chunk_id": CHUNK,
    "page_start": 4, "page_end": 5, "heading_path": ["Storage"], "trust": "licensed",
}


class ConversationStoreTests(unittest.TestCase):
    def test_create_and_list_use_authenticated_scope_and_transaction_local_rls(self):
        db = FakeConnection()
        created = create_conversation(db, tenant_id=TENANT, principal_id=USER)
        self.assertEqual(created["title"], "New chat")
        self.assertEqual(db.calls[0], ("SELECT set_config('app.tenant_id', %s, true)", (TENANT,)))
        self.assertEqual(db.calls[1], ("SELECT set_config('app.user_id', %s, true)", (USER,)))
        listed = list_conversations(db, tenant_id=TENANT, principal_id=USER)
        self.assertEqual(listed[0]["conversation_id"], CONVERSATION)
        list_query, params = db.calls[-1]
        self.assertIn("tenant_id=%s AND user_id=%s AND deleted_at IS NULL", list_query)
        self.assertEqual(params, (TENANT, USER, 50))

    def test_create_uses_compact_title_from_first_user_message(self):
        db = FakeConnection()
        created = create_conversation(
            db, tenant_id=TENANT, principal_id=USER,
            title="  How   should grain be stored in a long-term facility?  ",
        )
        self.assertEqual(created["title"], "How should grain be stored in a long-term facility?")
        insert = next((query, params) for query, params in db.calls if "INSERT INTO assistant_conversations" in query)
        self.assertEqual(insert[1][3], "How should grain be stored in a long-term facility?")

    def test_created_titles_are_normalized_and_truncated_with_ellipsis(self):
        db = FakeConnection()
        title = "How should we safely store grain in a facility during a very long winter season?"
        created = create_conversation(db, tenant_id=TENANT, principal_id=USER, title=title)
        self.assertEqual(created["title"], "How should we safely store grain in a facility during...")

    def test_append_writes_user_assistant_and_citation_in_one_scope(self):
        db = FakeConnection()
        ids = append_turn(
            db, tenant_id=TENANT, principal_id=USER, conversation_id=CONVERSATION,
            question="Where should grain be stored?", answer="Keep it dry.",
            citations=[CITATION], model="claude-test", token_count=23,
        )
        self.assertEqual(len(db.messages), 2)
        inserts = [(query, params) for query, params in db.calls if "INSERT INTO assistant_messages" in query]
        self.assertIn("VALUES (%s,%s,%s,%s,'user',%s)", inserts[0][0])
        self.assertEqual(inserts[0][1][4], "Where should grain be stored?")
        self.assertIn("VALUES (%s,%s,%s,%s,'assistant',%s,%s,%s)", inserts[1][0])
        self.assertEqual(inserts[1][1][4:6], ("Keep it dry.", "claude-test"))
        self.assertEqual(len(db.citations), 1)
        self.assertEqual(db.citations[0][4], 0)
        self.assertEqual(ids.keys(), {"user_message_id", "assistant_message_id"})
        title_update = next((query, params) for query, params in db.calls if "UPDATE assistant_conversations SET" in query)
        self.assertIn("last_message_at=clock_timestamp()", title_update[0])
        self.assertEqual(title_update[1][0], "Where should grain be stored?")

    def test_failed_citation_insert_rolls_back_both_messages(self):
        db = FakeConnection(fail_citation=True)
        with self.assertRaisesRegex(RuntimeError, "citation insert"):
            append_turn(
                db, tenant_id=TENANT, principal_id=USER, conversation_id=CONVERSATION,
                question="Question", answer="Answer", citations=[CITATION],
            )
        self.assertEqual(db.messages, [])
        self.assertEqual(db.citations, [])
        self.assertEqual(db.calls, [])

    def test_get_returns_citations_and_hides_unowned_or_deleted_conversation(self):
        db = FakeConnection()
        conversation = get_conversation(
            db, tenant_id=TENANT, principal_id=USER, conversation_id=CONVERSATION,
        )
        self.assertEqual(conversation["messages"][0]["citations"], [{
            "document_id": DOCUMENT, "document_version": 2, "chunk_id": CHUNK,
            "page_start": 4, "page_end": 5, "heading_path": ["Storage"], "trust": "licensed",
        }])
        self.assertIsNone(get_conversation(
            FakeConnection(owned=False), tenant_id=TENANT, principal_id=USER,
            conversation_id=CONVERSATION,
        ))

    def test_soft_delete_is_scoped_and_invalid_inputs_are_rejected(self):
        db = FakeConnection()
        self.assertTrue(soft_delete_conversation(
            db, tenant_id=TENANT, principal_id=USER, conversation_id=CONVERSATION,
        ))
        sql, params = db.calls[-1]
        self.assertIn("tenant_id=%s AND user_id=%s", sql)
        self.assertEqual(params, (TENANT, USER, CONVERSATION))
        with self.assertRaises(ValueError):
            append_turn(db, tenant_id=TENANT, principal_id=USER,
                        conversation_id=CONVERSATION, question="?", answer="Answer",
                        citations=[{**CITATION, "document_version": 0}])


if __name__ == "__main__":
    unittest.main()
