import unittest
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from unittest.mock import patch

from advisor_security.execution import AlertsExecutor, ExecutionError
from advisor_security.policy import Principal


class ExecutionTests(unittest.TestCase):
    def setUp(self):
        self.principal = Principal(str(uuid4()), str(uuid4()), "operator", "grain-advisor",
            datetime.now(timezone.utc) + timedelta(minutes=5))
        self.action = {"action": "acknowledge_alert", "target": str(uuid4()),
            "params": {"note": "reviewed"}, "preconditions": {"etag": '"1"'}}

    def test_successful_mutation_with_bad_receipt_body_is_still_recorded_as_success(self):
        executor = AlertsExecutor("http://127.0.0.1:8088")
        with patch("advisor_security.execution.bounded_request", return_value=(200, b"not-json")):
            receipt = executor(self.principal, self.action, "Bearer " + ("x" * 40), str(uuid4()))
        self.assertTrue(receipt["response_invalid"])
        self.assertIsNone(receipt["response"])

    def test_owner_authorization_failure_is_retryable_with_a_fresh_token(self):
        executor = AlertsExecutor("http://127.0.0.1:8088")
        with patch("advisor_security.execution.bounded_request", return_value=(401, b"")):
            with self.assertRaises(ExecutionError) as error:
                executor(self.principal, self.action, "Bearer " + ("x" * 40), str(uuid4()))
        self.assertTrue(error.exception.retryable)


if __name__ == "__main__":
    unittest.main()
