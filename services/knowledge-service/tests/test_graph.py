import unittest
from dataclasses import replace

from knowledge_extensions.graph import (
    InvalidGraphFact,
    make_candidate_fact,
    make_entity,
    traverse_reviewed,
)


TENANT_A = "11111111-1111-4111-8111-111111111111"
TENANT_B = "22222222-2222-4222-8222-222222222222"
DOC = "33333333-3333-4333-8333-333333333333"
CHUNK = "44444444-4444-4444-8444-444444444444"


def fact(source, target, *, tenant=TENANT_A, chunk=CHUNK, version=2, status="reviewed"):
    return replace(make_candidate_fact(
        tenant_id=tenant, source=source, predicate="indicated_by", target=target,
        document_id=DOC, document_version=version, chunk_id=chunk,
        span_start=5, span_end=28, trust="licensed",
    ), status=status)


class GraphProjectionTests(unittest.TestCase):
    def test_entity_ids_are_stable_and_scope_bound(self):
        self.assertEqual(make_entity(TENANT_A, "hazard", "  Hotspot ").entity_id,
                         make_entity(TENANT_A, "hazard", "hotspot").entity_id)
        self.assertNotEqual(make_entity(TENANT_A, "hazard", "hotspot").entity_id,
                            make_entity(TENANT_B, "hazard", "hotspot").entity_id)
        with self.assertRaises(InvalidGraphFact):
            make_entity(TENANT_A, "unknown", "hotspot")

    def test_only_reviewed_current_authorized_same_tenant_edges_traverse(self):
        grain = make_entity(TENANT_A, "grain", "wheat")
        hazard = make_entity(TENANT_A, "hazard", "hotspot")
        symptom = make_entity(TENANT_A, "symptom", "warm air")
        good = fact(grain, hazard)
        second = fact(hazard, symptom)
        candidate = fact(grain, symptom, status="candidate")
        stale = fact(grain, symptom, version=1)
        foreign_fact = replace(good, edge_id="foreign-edge", tenant_id=TENANT_B)

        result = traverse_reviewed(
            [good, second, candidate, stale, foreign_fact],
            tenant_id=TENANT_A,
            start_entity_id=grain.entity_id,
            authorized_chunk_ids={CHUNK},
            current_versions={DOC: 2},
        )
        self.assertEqual(result, (good, second))
        self.assertEqual(traverse_reviewed(
            [good], tenant_id=TENANT_A, start_entity_id=grain.entity_id,
            authorized_chunk_ids=set(), current_versions={DOC: 2},
        ), ())

    def test_cross_tenant_edges_and_unbounded_depth_are_rejected(self):
        a = make_entity(TENANT_A, "grain", "wheat")
        b = make_entity(TENANT_B, "hazard", "hotspot")
        with self.assertRaises(InvalidGraphFact):
            make_candidate_fact(tenant_id=TENANT_A, source=a, predicate="indicated_by",
                                target=b, document_id=DOC, document_version=1,
                                chunk_id=CHUNK, span_start=0, span_end=1, trust="licensed")
        with self.assertRaises(InvalidGraphFact):
            traverse_reviewed([], tenant_id=TENANT_A, start_entity_id=a.entity_id,
                              authorized_chunk_ids=set(), current_versions={}, max_depth=3)


if __name__ == "__main__":
    unittest.main()
