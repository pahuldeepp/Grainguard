import unittest
from unittest.mock import MagicMock, patch

from knowledge_extensions.service import KnowledgeRagService


class Context:
    def __enter__(self): return self
    def __exit__(self, *_): return None


class StaleIndexEventTests(unittest.TestCase):
    def service(self, parser, scanner, object_store):
        return KnowledgeRagService(
            connect=Context, vector_store=MagicMock(), model_gateway=MagicMock(),
            namespace_key=b"test-namespace-key-32-bytes-long", embedding_model="embed-v1",
            reranker_model="rank-v1", answer_model="answer-v1", object_store=object_store,
            parser=parser, scanner=scanner,
        )

    def test_deleted_or_superseded_events_skip_object_read_scan_and_parse(self):
        for source in (
            {"processed": False, "processing_status": "queued", "deleted": True,
             "latest_version": 4, "source_object_key": "private/key", "source_sha256": "a" * 64},
            {"processed": False, "processing_status": "queued", "deleted": False,
             "latest_version": 5, "source_object_key": "private/key", "source_sha256": "a" * 64},
        ):
            with self.subTest(source=source):
                parser, scanner, objects = MagicMock(), MagicMock(), MagicMock()
                service = self.service(parser, scanner, objects)
                with patch("knowledge_extensions.service.load_index_source", return_value=source), \
                     patch("knowledge_extensions.service.process_index_event", return_value=0) as index:
                    self.assertEqual(0, service.process_document_event(
                        tenant_id="11111111-1111-4111-8111-111111111111",
                        document_id="22222222-2222-4222-8222-222222222222",
                        document_version=4, event_id="33333333-3333-4333-8333-333333333333"))
                objects.get_pdf.assert_not_called()
                scanner.scan.assert_not_called()
                parser.parse.assert_not_called()
                index.assert_called_once()


if __name__ == "__main__":
    unittest.main()
