import threading
import unittest
from knowledge_extensions.kafka_runtime import consume_forever
from knowledge_extensions.pdf_parser import PdfParseError
from test_kafka_runtime import Message, TENANT, DOC, EVENT
import json

class Consumer:
    def __init__(self, stop):
        self.stop=stop
        self.commits=0
    def poll(self, timeout):
        message=Message(json.dumps({'schema_version':1,'tenant_id':TENANT,'document_id':DOC,
                                    'event_id':EVENT,'document_version':1}).encode())
        message.error=lambda:None
        return message
    def commit(self, **kwargs):
        self.commits+=1
        self.stop.set()

class Service:
    def __init__(self): self.failures=[]
    def process_document_event(self, **kwargs): raise PdfParseError('invalid PDF')
    def record_index_failure(self, **kwargs):
        self.failures.append(kwargs)
        return True

class RecoveryTests(unittest.TestCase):
    def test_permanent_pdf_failure_is_durably_recorded_before_offset_commit(self):
        stop=threading.Event()
        consumer=Consumer(stop)
        service=Service()
        consume_forever(consumer,service,stop=stop)
        self.assertEqual(consumer.commits,1)
        self.assertTrue(service.failures[0]['permanent'])
        self.assertEqual(service.failures[0]['event']['tenant_id'],TENANT)

class PromptInjectionRecoveryTests(unittest.TestCase):
    def test_policy_rejection_is_permanent_before_offset_commit(self):
        from knowledge_extensions.prompt_guardrails import PromptInjectionError
        class PolicyRejected(Service):
            def process_document_event(self,**kwargs):
                raise PromptInjectionError(('instruction_override',))
        stop=threading.Event();consumer=Consumer(stop);service=PolicyRejected()
        consume_forever(consumer,service,stop=stop)
        self.assertEqual(consumer.commits,1)
        self.assertTrue(service.failures[0]['permanent'])

class FailureRecorderOutageTests(unittest.TestCase):
    def test_recorder_outage_backs_off_before_durable_failure_and_commit(self):
        class RetryStop(threading.Event):
            def __init__(self):
                super().__init__()
                self.delays = []
            def wait(self, timeout=None):
                self.delays.append(timeout)
                assert consumer.commits == 0
                return False
        class FailingRecorder(Service):
            def record_index_failure(self, **kwargs):
                self.failures.append(kwargs)
                if len(self.failures) <= 2:
                    raise ConnectionError('synthetic database outage')
                return True
        stop = RetryStop()
        consumer = Consumer(stop)
        service = FailingRecorder()
        consume_forever(consumer, service, stop=stop)
        self.assertEqual(stop.delays, [15, 30])
        self.assertEqual(consumer.commits, 1)
        self.assertEqual(len(service.failures), 3)
        self.assertTrue(all(item['permanent'] for item in service.failures))

    def test_shutdown_during_recorder_outage_never_commits_offset(self):
        class StopOnWait(threading.Event):
            def wait(self, timeout=None):
                self.set()
                return True
        class FailingRecorder(Service):
            def record_index_failure(self, **kwargs):
                raise ConnectionError('synthetic database outage')
        stop = StopOnWait()
        consumer = Consumer(stop)
        consume_forever(consumer, FailingRecorder(), stop=stop)
        self.assertEqual(consumer.commits, 0)


class DurableDependencyRetryTests(unittest.TestCase):
    def test_outage_after_many_attempts_is_rescheduled_not_permanently_failed(self):
        from unittest.mock import MagicMock
        from knowledge_extensions.service import KnowledgeRagService
        for attempts, expected_delay in ((1,15),(5,240),(50,300)):
            db=MagicMock()
            db.__enter__.return_value=db
            source=MagicMock(); source.fetchone.return_value=(None,)
            failure=MagicMock(); failure.fetchone.return_value=(attempts,)
            db.execute.side_effect=[MagicMock(), source, failure, MagicMock()]
            service=object.__new__(KnowledgeRagService)
            service._connect=lambda:db
            with self.subTest(attempts=attempts):
                self.assertTrue(service.record_index_failure(event={'tenant_id':TENANT,'event_id':EVENT,'document_id':DOC,'document_version':1},permanent=False))
                calls=db.execute.call_args_list
                statement,args=calls[-1].args
                self.assertIn('available_at=clock_timestamp()',statement)
                self.assertIn('published_at=NULL',statement)
                self.assertEqual(args,(expected_delay,TENANT,EVENT))
                self.assertFalse(any("processing_status='failed'" in str(call) for call in calls))
                self.assertFalse(any('processed_at=clock_timestamp()' in str(call) for call in calls))
