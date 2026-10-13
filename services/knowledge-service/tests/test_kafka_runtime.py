import json
import unittest

from knowledge_extensions.kafka_runtime import TOPIC, decode_event


TENANT = "11111111-1111-4111-8111-111111111111"
DOC = "33333333-3333-4333-8333-333333333333"
EVENT = "44444444-4444-4444-8444-444444444444"


class Message:
    def __init__(self, value, key=f"{TENANT}:{DOC}"):
        self._value = value
        self._key = key.encode()

    def value(self):
        return self._value

    def key(self):
        return self._key


class KafkaRuntimeTests(unittest.TestCase):
    def test_id_only_event_contract_and_aggregate_key(self):
        payload = {"schema_version": 1, "event_id": EVENT, "tenant_id": TENANT,
                   "document_id": DOC, "document_version": 2}
        self.assertEqual(decode_event(Message(json.dumps(payload).encode())), payload)
        self.assertEqual(TOPIC, "greenguard.knowledge.document.index.requested.v1")

    def test_rejects_text_extra_fields_and_mismatched_kafka_key(self):
        payload = {"schema_version": 1, "event_id": EVENT, "tenant_id": TENANT,
                   "document_id": DOC, "document_version": 2, "pdf_text": "never in Kafka"}
        with self.assertRaises(ValueError):
            decode_event(Message(json.dumps(payload).encode()))
        payload.pop("pdf_text")
        with self.assertRaises(ValueError):
            decode_event(Message(json.dumps(payload).encode(), key="other-tenant:" + DOC))

    def test_postgres_bigint_version_boundary(self):
        payload={"schema_version":1,"event_id":EVENT,"tenant_id":TENANT,"document_id":DOC,"document_version":2**63-1}
        self.assertEqual(decode_event(Message(json.dumps(payload).encode())),payload)
        for value in [0,-1,True,2**63,10**100]:
            payload["document_version"]=value
            with self.subTest(value=value),self.assertRaises(ValueError):
                decode_event(Message(json.dumps(payload).encode()))


if __name__ == "__main__":
    unittest.main()

class RelayFenceTests(unittest.TestCase):
    def connection(self):
        from contextlib import nullcontext
        class Connection:
            calls=[]
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def transaction(self):return nullcontext()
            def execute(self,sql,params=()):
                self.calls.append((sql,params))
                class Result:
                    rowcount=1
                    def fetchall(self):return [(EVENT,DOC,1,'claim-one'),('next-event',DOC,1,'claim-two')]
                return Result()
        return Connection()
    def test_delivery_failure_releases_only_matching_fenced_claims(self):
        from knowledge_extensions.kafka_runtime import publish_pending_once
        class Producer:
            def produce(self,*args,**kwargs):raise BufferError('queue full')
        connection=self.connection()
        with self.assertRaises(BufferError):publish_pending_once(lambda:connection,Producer(),TENANT)
        releases=[(sql,params) for sql,params in connection.calls if sql.startswith('UPDATE knowledge_index_outbox SET claim_token=NULL')]
        self.assertEqual(len(releases),2)
        self.assertEqual(releases[0][1],(TENANT,EVENT,'claim-one'))
        self.assertIn('claim_token=%s',releases[0][0])
        self.assertIn('processed_at IS NULL',releases[0][0])
        self.assertNotIn('published_at=clock_timestamp()',str(releases))

    def test_suggestion_delivery_failure_releases_remaining_fenced_batch(self):
        from knowledge_extensions.kafka_runtime import publish_suggestion_usage_once
        from datetime import datetime, timezone
        connection = self.connection()
        original = connection.execute
        def execute(sql, params=()):
            result = original(sql, params)
            if 'WITH candidates AS' in sql:
                result.fetchall = lambda: [(EVENT, DOC, datetime.now(timezone.utc), 'claim-one'),
                                           ('next-event', DOC, datetime.now(timezone.utc), 'claim-two')]
            return result
        connection.execute = execute
        class Producer:
            def produce(self, *args, **kwargs): raise BufferError('queue full')
        with self.assertRaisesRegex(RuntimeError, 'Kafka delivery failed'):
            publish_suggestion_usage_once(lambda: connection, Producer(), TENANT)
        releases = [(sql, params) for sql, params in connection.calls
                    if sql.startswith('UPDATE assistant_suggestion_usage_outbox SET claim_token=NULL')]
        self.assertEqual([params for sql, params in releases],
                         [(TENANT, EVENT, 'claim-one'), (TENANT, 'next-event', 'claim-two')])
        self.assertTrue(all('published_at IS NULL' in sql and 'claim_token=%s' in sql for sql, _ in releases))
