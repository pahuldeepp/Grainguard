import unittest

from knowledge_extensions.outline import (
    InvalidOutline,
    ParsedBlock,
    build_outline,
    expand_outline_selection,
)


TENANT = "11111111-1111-4111-8111-111111111111"
DOC = "33333333-3333-4333-8333-333333333333"
CHUNK_1 = "44444444-4444-4444-8444-444444444444"
CHUNK_2 = "55555555-5555-4555-8555-555555555555"
CHUNK_3 = "66666666-6666-4666-8666-666666666666"


class OutlineTests(unittest.TestCase):
    def setUp(self):
        self.outline = build_outline(
            tenant_id=TENANT,
            document_id=DOC,
            document_version=3,
            blocks=[
                ParsedBlock("heading", "Storage", 1, 1, heading_level=1),
                ParsedBlock("chunk", "paragraph", 2, 2, chunk_id=CHUNK_1),
                ParsedBlock("heading", "Moisture", 3, 3, heading_level=2),
                ParsedBlock("chunk", "table", 4, 5, chunk_id=CHUNK_2),
                ParsedBlock("heading", "Moisture", 6, 6, heading_level=2),
                ParsedBlock("chunk", "second section", 7, 7, chunk_id=CHUNK_3),
            ],
        )

    def test_outline_is_stable_nested_and_preserves_chunk_page_spans(self):
        rebuilt = build_outline(
            tenant_id=TENANT, document_id=DOC, document_version=3,
            blocks=[
                ParsedBlock("heading", "Storage", 1, 1, heading_level=1),
                ParsedBlock("chunk", "paragraph", 2, 2, chunk_id=CHUNK_1),
                ParsedBlock("heading", "Moisture", 3, 3, heading_level=2),
                ParsedBlock("chunk", "table", 4, 5, chunk_id=CHUNK_2),
                ParsedBlock("heading", "Moisture", 6, 6, heading_level=2),
                ParsedBlock("chunk", "second section", 7, 7, chunk_id=CHUNK_3),
            ],
        )
        self.assertEqual([n.node_id for n in self.outline.roots], [n.node_id for n in rebuilt.roots])
        storage = self.outline.roots[0]
        self.assertEqual(storage.page_end, 7)
        self.assertEqual(len(storage.children), 2)
        self.assertNotEqual(storage.children[0].node_id, storage.children[1].node_id)
        self.assertEqual(self.outline.chunk_ids, (CHUNK_1, CHUNK_2, CHUNK_3))

    def test_section_expansion_is_acl_filtered_and_bounded(self):
        storage = self.outline.roots[0]
        self.assertEqual(
            expand_outline_selection(
                self.outline,
                selected_node_ids=[storage.node_id],
                authorized_chunk_ids={CHUNK_1, CHUNK_2},
                max_chunks=8,
            ),
            (CHUNK_1, CHUNK_2),
        )
        self.assertEqual(
            expand_outline_selection(
                self.outline,
                selected_node_ids=[storage.node_id],
                authorized_chunk_ids={CHUNK_1, CHUNK_2, CHUNK_3},
                max_chunks=1,
            ),
            (CHUNK_1,),
        )

    def test_unknown_duplicate_and_invalid_selection_fail_closed(self):
        with self.assertRaises(InvalidOutline):
            expand_outline_selection(self.outline, selected_node_ids=["77777777-7777-4777-8777-777777777777"],
                                     authorized_chunk_ids={CHUNK_1})
        with self.assertRaises(InvalidOutline):
            expand_outline_selection(self.outline,
                                     selected_node_ids=[self.outline.roots[0].node_id] * 2,
                                     authorized_chunk_ids={CHUNK_1})
        with self.assertRaises(InvalidOutline):
            build_outline(tenant_id=TENANT, document_id=DOC, document_version=0, blocks=[])


if __name__ == "__main__":
    unittest.main()
