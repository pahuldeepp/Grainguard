import json
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4
import unittest

from advisor_security.execution import AlertsExecutor, ExecutionError
from advisor_security.policy import Principal


class ExecutionTests(unittest.TestCase):
    def setUp(self):
        self.alert_id = str(uuid4())
        self.token = 't' * 48
        self.key = str(uuid4())
        self.seen = []
        parent = self

        class Owner(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                parent.seen.append({
                    'path': self.path,
                    'authorization': self.headers.get('Authorization'),
                    'etag': self.headers.get('If-Match'),
                    'idempotency': self.headers.get('Idempotency-Key'),
                    'body': self.rfile.read(int(self.headers.get('Content-Length', '0'))),
                })
                if self.headers.get('Authorization') != 'Bearer ' + parent.token:
                    self.send_response(403); self.end_headers(); return
                if parent.stale:
                    self.send_response(412); self.end_headers(); return
                raw = json.dumps({'episodeId': parent.alert_id, 'state': 'acknowledged', 'version': 2}).encode()
                self.send_response(200); self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw)

        self.stale = False
        self.owner = ThreadingHTTPServer(('127.0.0.1', 0), Owner)
        threading.Thread(target=self.owner.serve_forever, daemon=True).start()
        self.executor = AlertsExecutor(f'http://127.0.0.1:{self.owner.server_port}')

    def tearDown(self):
        self.owner.shutdown(); self.owner.server_close()

    def principal(self):
        return Principal(str(uuid4()), str(uuid4()), 'operator', 'grain-advisor',
                         datetime.now(timezone.utc) + timedelta(minutes=5))

    def action(self):
        return {'action': 'acknowledge_alert', 'target': self.alert_id,
                'params': {'note': 'Review this alert'},
                'preconditions': {'etag': '"1"'}}

    def test_owner_call_has_fresh_token_etag_and_idempotency(self):
        receipt = self.executor(self.principal(), self.action(), 'Bearer ' + self.token, self.key)
        self.assertEqual(receipt['response']['state'], 'acknowledged')
        self.assertEqual(len(self.seen), 1)
        self.assertEqual(self.seen[0]['authorization'], 'Bearer ' + self.token)
        self.assertEqual(self.seen[0]['etag'], '"1"')
        self.assertEqual(self.seen[0]['idempotency'], self.key)

    def test_owner_version_conflict_is_not_retried(self):
        self.stale = True
        with self.assertRaises(ExecutionError) as error:
            self.executor(self.principal(), self.action(), 'Bearer ' + self.token, self.key)
        self.assertEqual(error.exception.code, 'owner_version_conflict')
        self.assertFalse(error.exception.retryable)

    def test_invalid_action_and_token_fail_closed(self):
        with self.assertRaises(ExecutionError):
            self.executor(self.principal(), {**self.action(), 'preconditions': {'etag': 'stale'}}, 'Bearer ' + self.token, self.key)
        with self.assertRaises(ExecutionError) as error:
            self.executor(self.principal(), self.action(), 'not-a-token', self.key)
        self.assertEqual(error.exception.code, 'owner_token_required')
