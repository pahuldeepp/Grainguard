import json
from pathlib import Path
import unittest

from knowledge_extensions.outline import (
    InvalidOutline, build_outline, resolve_chunk_citation, ParsedBlock,
)
from knowledge_extensions.parser_adapter import InvalidParserOutput, parse_parser_output


TENANT = "11111111-1111-4111-8111-111111111111"
DOC = "33333333-3333-4333-8333-333333333333"
CHUNK_1 = "44444444-4444-4444-8444-444444444444"
CHUNK_2 = "55555555-5555-4555-8555-555555555555"
FIXTURE = Path(__file__).parent / "fixtures" / "synthetic-grain-guide.parser.v1.json"


class ParserOutlineIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.raw = FIXTURE.read_text()
        self.outline = parse_parser_output(
            self.raw,
            tenant_id=TENANT,
            expected_document_id=DOC,
            expected_document_version=3,
            canonical_chunk_ids={CHUNK_1, CHUNK_2},
        )

    def test_parser_blocks_build_stable_outline_and_citation_metadata(self):
        citation = resolve_chunk_citation(
            self.outline,
            chunk_id=CHUNK_2,
            expected_tenant_id=TENANT,
            expected_document_id=DOC,
            expected_document_version=3,
            authorized_chunk_ids={CHUNK_1, CHUNK_2},
        )
        self.assertEqual(citation.page_start, 3)
        self.assertEqual(citation.page_end, 4)
        self.assertEqual(citation.heading_path, ("Storage conditions", "Moisture guidance"))
        self.assertEqual(self.outline.chunk_ids, (CHUNK_1, CHUNK_2))
        self.assertNotIn("Synthetic fixture text", repr(citation))

    def test_parser_identity_chunk_allowlist_and_unknown_fields_fail_closed(self):
        with self.assertRaises(InvalidParserOutput):
            parse_parser_output(self.raw, tenant_id=TENANT, expected_document_id=TENANT,
                                expected_document_version=3,
                                canonical_chunk_ids={CHUNK_1, CHUNK_2})
        payload = json.loads(self.raw)
        payload["blocks"][1]["chunk_id"] = "66666666-6666-4666-8666-666666666666"
        with self.assertRaises(InvalidParserOutput):
            parse_parser_output(json.dumps(payload), tenant_id=TENANT,
                                expected_document_id=DOC, expected_document_version=3,
                                canonical_chunk_ids={CHUNK_1, CHUNK_2})
        payload = json.loads(self.raw)
        payload["blocks"][0]["tenant_id"] = TENANT
        with self.assertRaises(InvalidParserOutput):
            parse_parser_output(json.dumps(payload), tenant_id=TENANT,
                                expected_document_id=DOC, expected_document_version=3,
                                canonical_chunk_ids={CHUNK_1, CHUNK_2})

    def test_citations_require_current_scope_and_authorized_chunk(self):
        with self.assertRaises(InvalidOutline):
            resolve_chunk_citation(
                self.outline, chunk_id=CHUNK_2, expected_tenant_id=TENANT,
                expected_document_id=DOC, expected_document_version=4,
                authorized_chunk_ids={CHUNK_2},
            )
        with self.assertRaises(InvalidOutline):
            resolve_chunk_citation(
                self.outline, chunk_id=CHUNK_2, expected_tenant_id=TENANT,
                expected_document_id=DOC, expected_document_version=3,
                authorized_chunk_ids={CHUNK_1},
            )

    def test_duplicate_json_keys_are_rejected(self):
        with self.assertRaises(InvalidParserOutput):
            parse_parser_output('{"schema_version":1,"schema_version":1}',
                                tenant_id=TENANT, expected_document_id=DOC,
                                expected_document_version=3,
                                canonical_chunk_ids={CHUNK_1, CHUNK_2})

    def test_duplicate_parent_heading_paths_still_have_unique_stable_node_ids(self):
        blocks = [
            ParsedBlock("heading", "Part", 1, 1, heading_level=1),
            ParsedBlock("heading", "Section", 2, 2, heading_level=2),
            ParsedBlock("chunk", "first", 2, 2, chunk_id=CHUNK_1),
            ParsedBlock("heading", "Part", 3, 3, heading_level=1),
            ParsedBlock("heading", "Section", 4, 4, heading_level=2),
            ParsedBlock("chunk", "second", 4, 4, chunk_id=CHUNK_2),
        ]
        first = build_outline(tenant_id=TENANT, document_id=DOC,
                              document_version=3, blocks=blocks)
        second = build_outline(tenant_id=TENANT, document_id=DOC,
                               document_version=3, blocks=blocks)
        self.assertEqual(first.roots[0].node_id, second.roots[0].node_id)
        self.assertNotEqual(first.roots[0].children[0].node_id,
                            first.roots[1].children[0].node_id)


if __name__ == "__main__":
    unittest.main()
