import unittest
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from advisor_security.policy import Principal, PolicyDenied, TurnBudget
from advisor_security.tools import call


class AuditDb:
    def __init__(self): self.statements = []
    def transaction(self): return self
    def __enter__(self): return self
    def __exit__(self, *_): return False
    def execute(self, statement, *_args): self.statements.append(statement)


class ToolBudgetTests(unittest.TestCase):
    def test_invalid_model_calls_are_limited_before_append_only_denial_audits(self):
        principal = Principal(str(uuid4()), str(uuid4()), "operator", "grain-advisor",
            datetime.now(timezone.utc) + timedelta(minutes=5))
        budget = TurnBudget(principal, str(uuid4()))
        db = AuditDb()
        for _ in range(8):
            with self.assertRaises(PolicyDenied):
                call(db, principal, budget, "not_a_tool", {}, knowledge=lambda *_: {})
        audit_rows = sum("INSERT INTO advisor_security_audit" in sql for sql in db.statements)
        outbox_rows = sum("INSERT INTO advisor_security_outbox" in sql for sql in db.statements)
        self.assertEqual((audit_rows, outbox_rows), (8, 8))
        with self.assertRaises(PolicyDenied):
            call(db, principal, budget, "not_a_tool", {}, knowledge=lambda *_: {})
        self.assertEqual(sum("INSERT INTO advisor_security_audit" in sql for sql in db.statements), 8)
        self.assertEqual(sum("INSERT INTO advisor_security_outbox" in sql for sql in db.statements), 8)


if __name__ == "__main__":
    unittest.main()
