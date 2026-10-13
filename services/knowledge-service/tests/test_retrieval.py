import unittest

from knowledge_extensions.retrieval import reciprocal_rank_fusion, tenant_namespace, _generation_source, RetrievalError, _deduplicate_authorized_sources


class RetrievalAlgorithmTests(unittest.TestCase):
    def test_generation_receives_canonical_page_metadata(self):
        source = {"chunk_id": "c1", "trust": "curated", "text": "Section three",
                  "document_id": "11111111-1111-4111-8111-111111111111",
                  "document_version": 2, "page_start": 4, "page_end": 5}
        self.assertEqual(_generation_source(source), source)
        for patch in ({"document_id": "not-a-uuid"}, {"page_start": 0}, {"page_end": 3}, {"document_version": True}):
            with self.assertRaises(RetrievalError):
                _generation_source(source | patch)

    def test_duplicate_authorized_text_keeps_first_canonical_source(self):
        first = {"chunk_id": "first", "document_id": "authorized-one", "text": "same evidence"}
        duplicate = {"chunk_id": "second", "document_id": "authorized-two", "text": "same evidence"}
        unique = {"chunk_id": "third", "text": "different section"}
        self.assertEqual(_deduplicate_authorized_sources([first, duplicate, unique]), [first, unique])

    def test_rrf_combines_dense_lexical_outline_and_graph_rankings(self):
        fused = reciprocal_rank_fusion([
            ["shared", "dense-only"],
            ["shared", "fts-only"],
            ["outline-only", "shared"],
            ["graph-only", "shared"],
        ], limit=5)
        self.assertEqual(fused[0], "shared")
        self.assertEqual(set(fused), {"shared", "dense-only", "fts-only", "outline-only", "graph-only"})

    def test_namespace_is_a_tenant_bound_hmac_pseudonym(self):
        key = b"x" * 32
        first = tenant_namespace("11111111-1111-4111-8111-111111111111", key)
        second = tenant_namespace("22222222-2222-4222-8222-222222222222", key)
        self.assertNotEqual(first, second)
        self.assertTrue(first.startswith("t_"))
        with self.assertRaises(ValueError):
            tenant_namespace("11111111-1111-4111-8111-111111111111", b"weak")


if __name__ == "__main__":
    unittest.main()
