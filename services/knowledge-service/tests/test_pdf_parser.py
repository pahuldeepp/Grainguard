import unittest

from knowledge_extensions.pdf_parser import PdfParseError, parse_pdf
from pdf_fixture import make_text_pdf


TENANT = "11111111-1111-4111-8111-111111111111"
DOC = "33333333-3333-4333-8333-333333333333"


class PdfParserTests(unittest.TestCase):
    def setUp(self):
        self.pdf = make_text_pdf([
            ["Humidity Management", "Keep stored wheat dry to reduce the risk of mold."],
            ["Ventilation", "Move air through the grain during humid storage conditions."],
        ])

    def test_real_pdf_text_layer_becomes_canonical_chunks_and_outline(self):
        parsed = parse_pdf(self.pdf, tenant_id=TENANT, document_id=DOC, document_version=1)
        self.assertEqual(len(parsed.chunks), 2)
        self.assertEqual(parsed.chunks[0].page_start, 1)
        self.assertEqual(parsed.chunks[1].page_start, 2)
        self.assertIn("Keep stored wheat dry", parsed.chunks[0].content)
        self.assertEqual(parsed.chunks[0].heading_path, ("Humidity Management",))
        self.assertEqual(parsed.outline.chunk_ids, tuple(chunk.chunk_id for chunk in parsed.chunks))
        again = parse_pdf(self.pdf, tenant_id=TENANT, document_id=DOC, document_version=1)
        self.assertEqual(parsed.outline.chunk_ids, again.outline.chunk_ids)

    def test_bad_or_scanned_pdf_fails_closed(self):
        with self.assertRaises(PdfParseError):
            parse_pdf(b"not a pdf at all", tenant_id=TENANT, document_id=DOC, document_version=1)
        scanned = make_text_pdf([[]])
        with self.assertRaises(PdfParseError):
            parse_pdf(scanned, tenant_id=TENANT, document_id=DOC, document_version=1)

class HeadingBoundaryTests(unittest.TestCase):
    def test_wrapped_prose_is_not_heading_and_titles_remain_in_chunks(self):
        from knowledge_extensions.pdf_parser import _looks_like_heading
        self.assertIsNone(_looks_like_heading(["Keep stored wheat dry to", "reduce the risk of mold during storage."], 0))
        parsed = parse_pdf(make_text_pdf([["Humidity Management", "Keep stored wheat dry to reduce mold risk."]]), tenant_id=TENANT, document_id=DOC, document_version=1)
        self.assertIn("Humidity Management", parsed.chunks[0].content)


if __name__ == "__main__":
    unittest.main()

class OcrParserTests(unittest.TestCase):
    def test_injected_sandbox_ocr_produces_canonical_scanned_pages(self):
        parsed=parse_pdf(make_text_pdf([[],[]]),tenant_id=TENANT,document_id=DOC,document_version=1,
            ocr=lambda page:'SCANNED OPERATING PROCEDURE\nInspect the storage bin every morning before filling.')
        self.assertEqual([chunk.page_start for chunk in parsed.chunks],[1,2])
        self.assertIn('Inspect the storage bin',parsed.chunks[0].content)
    def test_ocr_pages_are_bounded(self):
        with self.assertRaises(PdfParseError):
            parse_pdf(make_text_pdf([[]]*21),tenant_id=TENANT,document_id=DOC,document_version=1,
                ocr=lambda page:'Scanned content')
    def test_text_layer_does_not_call_ocr(self):
        def unexpected(page):raise AssertionError('text layer should be preserved')
        parsed=parse_pdf(make_text_pdf([['This long text-layer procedure already has more than forty characters.']]),
            tenant_id=TENANT,document_id=DOC,document_version=1,ocr=unexpected)
        self.assertEqual(len(parsed.chunks),1)


class InvalidOutlineClassificationTests(unittest.TestCase):
    def test_invalid_outline_is_a_permanent_parse_error(self):
        from unittest.mock import patch
        from knowledge_extensions.outline import InvalidOutline
        from pdf_fixture import make_text_pdf
        original = InvalidOutline('invalid outline')
        with patch('knowledge_extensions.pdf_parser.build_outline', side_effect=original):
            with self.assertRaises(PdfParseError) as caught:
                parse_pdf(make_text_pdf([['A valid extracted passage for outline classification.']]),
                          tenant_id=TENANT, document_id=DOC, document_version=1)
        self.assertIs(caught.exception.__cause__, original)
