import json
import os
import unittest
from unittest.mock import patch

from ml_scoring.analytics import clickhouse_summary


class ClickHouseSummaryTests(unittest.TestCase):
    def test_unconfigured_is_nonfatal_and_explicit(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(clickhouse_summary("0a0a0a0a-0000-4000-8000-00000000000a"), {
                "status": "unavailable", "reason": "not_configured", "rows": 0,
                "bins": 0, "averageTemperatureC": None, "averageHumidityPercent": None,
            })

    def test_queries_are_parameterized_and_aggregate_returned(self):
        seen = []
        class Response:
            def __init__(self, body): self.body = body
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self): return self.body
        def fake_open(request, timeout):
            seen.append((request, timeout))
            return Response(b'{"rows":1536,"bins":8,"averageTemperatureC":22.5,"averageHumidityPercent":64.0}\n')
        with patch.dict(os.environ, {"ML_CLICKHOUSE_URL": "http://127.0.0.1:8128"}, clear=True), \
             patch("ml_scoring.analytics.urlopen", fake_open):
            value = clickhouse_summary("0a0a0a0a-0000-4000-8000-00000000000a")
        self.assertEqual(value["status"], "ready")
        self.assertEqual(value["rows"], 1536)
        self.assertEqual(value["bins"], 8)
        self.assertEqual(len(seen), 1)
        self.assertIn("param_tenant_id=0a0a0a0a-0000-4000-8000-00000000000a", seen[0][0].full_url)
        self.assertNotIn("0a0a0a0a", seen[0][0].data.decode())

    def test_unavailable_clickhouse_does_not_break_snapshot(self):
        with patch.dict(os.environ, {"ML_CLICKHOUSE_URL": "http://127.0.0.1:8128"}, clear=True), \
             patch("ml_scoring.analytics.urlopen", side_effect=OSError("offline")):
            self.assertEqual(clickhouse_summary("0a0a0a0a-0000-4000-8000-00000000000a")["reason"], "query_failed")


if __name__ == "__main__":
    unittest.main()
