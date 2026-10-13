import copy
import json
import unittest
from unittest.mock import Mock,patch
from usage_pipeline import validate,decode,consume_once,TOPIC,event_key

TENANT='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
EVENT=dict(schema_version=1,tenant_id=TENANT,attempt_id='attempt-1',principal_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
           occurred_at='2026-10-04T12:00:00+00:00',period='2026-10-01',model='answer-v1',provider='anthropic',tokens=12,micros=34,usage_known=True)

class UsageTests(unittest.TestCase):
    def test_strict_contract_rejects_private_fields_forgery_and_bool_counters(self):
        self.assertEqual(validate(EVENT,event_key(EVENT)),EVENT)
        for mutation in ({'prompt':'private'},{'tenant_id':'bad'},{'tokens':True},{'micros':-1},
                         {'usage_known':1},{'period':'2026-10-02'},{'occurred_at':'2026-10-04T12:00:00'},
                         {'provider':'evil'},{'model':'private model text'}):
            with self.subTest(mutation=mutation),self.assertRaises((TypeError,ValueError)):
                validate(EVENT|mutation)
        with self.assertRaises(ValueError):validate(EVENT,'wrong-key')

    def test_decoder_bounds_and_topic(self):
        message=Mock();message.value.return_value=json.dumps(EVENT).encode();message.key.return_value=event_key(EVENT).encode()
        self.assertEqual(decode(message),EVENT)
        message.value.return_value=b'x'*8193
        with self.assertRaises(ValueError):decode(message)

    def test_commit_is_after_transaction_and_record_specific(self):
        message=Mock();message.value.return_value=json.dumps(EVENT).encode();message.key.return_value=event_key(EVENT).encode()
        message.error.return_value=None;message.topic.return_value=TOPIC
        consumer=Mock();consumer.poll.return_value=message
        order=[]
        with patch('usage_pipeline.apply_event',side_effect=lambda *_:order.append('database_commit') or True):
            consumer.commit.side_effect=lambda **kw:order.append('offset_commit')
            self.assertTrue(consume_once(None,consumer,{TENANT}))
        self.assertEqual(order,['database_commit','offset_commit'])
        consumer.commit.assert_called_once_with(message=message,asynchronous=False)

    def test_db_outage_and_disallowed_tenant_do_not_commit(self):
        message=Mock();message.value.return_value=json.dumps(EVENT).encode();message.key.return_value=event_key(EVENT).encode()
        message.error.return_value=None;message.topic.return_value=TOPIC
        consumer=Mock();consumer.poll.return_value=message
        with patch('usage_pipeline.apply_event',side_effect=RuntimeError('db unavailable')):
            with self.assertRaises(RuntimeError):consume_once(None,consumer,{TENANT})
        with self.assertRaises(PermissionError):consume_once(None,consumer,set())
        consumer.commit.assert_not_called()

    def test_duplicate_still_commits_record(self):
        message=Mock();message.value.return_value=json.dumps(EVENT).encode();message.key.return_value=event_key(EVENT).encode()
        message.error.return_value=None;message.topic.return_value=TOPIC
        consumer=Mock();consumer.poll.return_value=message
        with patch('usage_pipeline.apply_event',return_value=False):
            self.assertFalse(consume_once(None,consumer,{TENANT}))
        consumer.commit.assert_called_once_with(message=message,asynchronous=False)
