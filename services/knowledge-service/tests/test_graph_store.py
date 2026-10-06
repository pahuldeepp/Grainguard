import unittest
from unittest.mock import MagicMock
from knowledge_extensions.graph_store import retrieve_reviewed_facts

class GraphStoreTests(unittest.TestCase):
    def test_cycles_do_not_repeat_facts_or_consume_budget(self):
        ids = [f"{n:08d}-1111-4111-8111-111111111111" for n in range(1, 8)]
        tenant, start, target, chunk, document, first, second = ids
        row = lambda fact, source, dest: (fact, source, "indicated_by", dest, document, 1, chunk, 0, 3, "licensed")
        connection = MagicMock()
        connection.execute.return_value.fetchall.side_effect = [[row(first,start,target)], [row(first,start,target), row(second,target,start)]]
        result = retrieve_reviewed_facts(connection, tenant_id=tenant, start_entity_id=start, authorized_chunk_ids={chunk}, max_facts=3)
        self.assertEqual([first,second], [item["fact_id"] for item in result])
        calls = [call for call in connection.execute.call_args_list if "SELECT f.fact_id" in call.args[0]]
        self.assertEqual([], calls[0].args[1][3])
        self.assertEqual([first], calls[1].args[1][3])
        self.assertIn("NOT (f.fact_id = ANY", calls[1].args[0])
