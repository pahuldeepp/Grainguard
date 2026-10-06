from contextlib import nullcontext
from unittest.mock import patch
import threading,unittest
from summary_worker import process_once

class Connection:
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def transaction(self):return nullcontext()
    def execute(self,sql,params=()):
        class Result:
            def fetchall(self):return [('user-1',),('user-2',)]
        return Result()
class WorkerDiscoveryTests(unittest.TestCase):
    def test_no_idle_member_scan_and_stop_between_principals(self):
        stop=threading.Event()
        def claimed(*args):stop.set();return None
        with patch('summary_worker.claim_summary_job',side_effect=claimed) as claim:
            self.assertEqual(process_once(Connection,tenant='tenant',models=None,memberships=None,stop=stop),0)
        self.assertEqual(claim.call_count,1)
