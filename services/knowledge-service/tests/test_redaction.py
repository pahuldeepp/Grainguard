import unittest
from knowledge_extensions.redaction import redact_text, redact_passages

class RedactionTests(unittest.TestCase):
    def test_sensitive_formats_and_idempotence(self):
        for value in ['operator@example.invalid', 'oper\u200bator@example.invalid', 'ｏｐｅｒａｔｏｒ＠ｅｘａｍｐｌｅ．ｉｎｖａｌｉｄ', '204-555-1234', 'sk-ant-'+'x'*32, 'pcsk_'+'x'*32, 'AKIA'+'A'*16, 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature', 'password=fictional-value', 'Bearer fictional-token']:
            with self.subTest(value=value):
                safe = redact_text(value)
                self.assertNotIn(value, safe)
                self.assertEqual(redact_text(safe), safe)
    def test_agricultural_numbers_and_identity(self):
        text = 'Moisture 13.5%, temperature 20 C, 2026-10-01, document aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa page 12.'
        self.assertEqual(redact_text(text), text)
    def test_multiline_and_split_private_key(self):
        self.assertNotIn('sensitive', redact_text('-----BEGIN PRIVATE KEY-----\nsensitive\n-----END PRIVATE KEY-----'))
        self.assertEqual(redact_passages(['-----BEGIN PRIVATE KEY-----', 'sensitive', '-----END PRIVATE KEY-----']), ['[REDACTED_PRIVATE_KEY]']*3)
    def test_bounded(self):
        with self.assertRaises(ValueError): redact_text('x'*2_000_001)
