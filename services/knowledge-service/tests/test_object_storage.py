import unittest

from knowledge_extensions.object_storage import S3PdfObjectStore, S3SourceConfig
from knowledge_extensions.pdf_parser import parse_pdf
from hashlib import sha256
from pdf_fixture import make_text_pdf


class FakeS3:
    def __init__(self):
        self.put = None
        self.deleted = None

    def put_object(self, **kwargs):
        self.put = kwargs

    def delete_object(self, **kwargs):
        self.deleted = kwargs


class ObjectStorageTests(unittest.TestCase):
    def test_upload_uses_immutable_scoped_key_and_kms_encryption(self):
        fake = FakeS3()
        store = S3PdfObjectStore(
            S3SourceConfig("gg-private-docs", "ca-central-1", "alias/gg-knowledge"), client=fake,
        )
        pdf = make_text_pdf([["Dry storage keeps wheat safe from mold."]])
        parsed = parse_pdf(
            pdf, tenant_id="11111111-1111-4111-8111-111111111111",
            document_id="33333333-3333-4333-8333-333333333333", document_version=2,
        )
        key = store.put_pdf(pdf, tenant_id=parsed.tenant_id, document_id=parsed.document_id,
                            document_version=parsed.document_version,
                            source_sha256=parsed.source_sha256)
        self.assertIn(parsed.source_sha256, key)
        self.assertEqual(fake.put["Key"], key)
        self.assertEqual(fake.put["ServerSideEncryption"], "aws:kms")
        self.assertEqual(fake.put["SSEKMSKeyId"], "alias/gg-knowledge")
        store.delete_pdf(key)
        self.assertEqual(fake.deleted["Key"], key)

    def test_requires_encryption_and_rejects_public_http_endpoint(self):
        with self.assertRaises(ValueError):
            S3PdfObjectStore(S3SourceConfig("gg-private-docs", "ca-central-1", ""), client=FakeS3())
        with self.assertRaises(ValueError):
            S3PdfObjectStore(
                S3SourceConfig("gg-private-docs", "ca-central-1", "kms", "http://s3.example.org"),
                client=FakeS3(),
            )


if __name__ == "__main__":
    unittest.main()
