"""Protected-file and exact identity contracts using invented credentials only."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('prepare_acceptance', Path(__file__).with_name('prepare-acceptance-secrets.py'))
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)
SCOPE = {'account_id': '123456789012', 'region': 'us-east-1', 'environment': 'sandbox', 'cluster_name': 'greenguard-sandbox-cell-1'}


def fixture():
    return {'target_account_id': SCOPE['account_id'], 'environment': 'sandbox', 'cluster_name': SCOPE['cluster_name'],
            'unrelated': {'keep': ['exact', 'values']},
            'secret_version_counters': {'runtime/greenguard-kafka-auth': 7, 'other': 9},
            'runtime_secret_values': {'greenguard-kafka-auth': {
                'broker-jaas': MOD.MODULE + ' required username="broker" password="fake-broker-secret" user_broker="fake-broker-secret" user_admin="fake-admin-secret";',
                'keep': 'opaque-existing-material'},
                'greenguard-opensearch-clients': {'writer-password': 'fake-search-writer', 'reader-password': 'fake-search-reader'},
                'unchanged': {'key': 'fake-existing'}}}


class PrepareTests(unittest.TestCase):
    def test_preserves_every_mapping_and_is_idempotent_without_rotation(self):
        original = fixture()
        enriched = MOD.enrich(original, SCOPE)
        self.assertNotIn('acceptance-client-jaas', original['runtime_secret_values']['greenguard-kafka-auth'])
        self.assertEqual(enriched['unrelated'], original['unrelated'])
        self.assertEqual(enriched['runtime_secret_values']['unchanged'], original['runtime_secret_values']['unchanged'])
        old_broker = MOD.parse_broker(original['runtime_secret_values']['greenguard-kafka-auth']['broker-jaas'])
        new_broker = MOD.parse_broker(enriched['runtime_secret_values']['greenguard-kafka-auth']['broker-jaas'])
        self.assertEqual({k: v for k, v in new_broker.items() if k != 'user_acceptance-probe'}, old_broker)
        client = enriched['runtime_secret_values']['greenguard-kafka-auth']['acceptance-client-jaas']
        self.assertEqual(MOD.CLIENT.fullmatch(client)[1], new_broker['user_acceptance-probe'])
        self.assertEqual(enriched['secret_version_counters']['runtime/greenguard-kafka-auth'], 8)
        self.assertEqual(enriched['secret_version_counters']['runtime/greenguard-opensearch-clients'], 2)
        self.assertEqual(enriched['secret_version_counters']['other'], 9)
        self.assertEqual(MOD.enrich(enriched, SCOPE), enriched)

    def test_scopes_reject_production_mismatched_account_and_cell(self):
        for scope in [{**SCOPE, 'environment': 'prod'}, {**SCOPE, 'account_id': '000000000000'},
                      {**SCOPE, 'cluster_name': 'shared-cluster'}, {**SCOPE, 'extra': 'bad'}]:
            with self.subTest(scope=scope), self.assertRaises(ValueError): MOD.enrich(fixture(), scope)

    def test_malformed_duplicate_or_partial_jaas_fail_closed(self):
        for stanza in ['', 'x required username="broker";',
                       MOD.MODULE + ' required username="broker" password="a" user_broker="b";',
                       MOD.MODULE + ' required username="broker" password="a" user_broker="a" user_admin="x" user_admin="y";',
                       MOD.MODULE + ' required username="broker" password="a" user_broker="a" super.users="acceptance-probe";']:
            value = fixture()
            value['runtime_secret_values']['greenguard-kafka-auth']['broker-jaas'] = stanza
            with self.subTest(stanza=bool(stanza)), self.assertRaises(ValueError): MOD.enrich(value, SCOPE)
        value = fixture()
        value['runtime_secret_values']['greenguard-kafka-auth']['acceptance-client-jaas'] = MOD.MODULE + ' required username="admin" password="' + 'x' * 48 + '";'
        with self.assertRaises(ValueError): MOD.enrich(value, SCOPE)

    def test_partial_or_reused_search_credentials_fail_closed(self):
        value = fixture()
        value['runtime_secret_values']['greenguard-opensearch-clients']['acceptance-reader-password'] = 'partial'
        with self.assertRaises(ValueError): MOD.enrich(value, SCOPE)
        value = MOD.enrich(fixture(), SCOPE)
        source = value['runtime_secret_values']['greenguard-opensearch-clients']
        source['acceptance-reader-password'] = source['reader-password']
        with self.assertRaises(ValueError): MOD.enrich(value, SCOPE)

    def test_protected_file_output_never_overwrites_and_shows_no_secret(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            source, target, scope = [directory / name for name in ['source.json', 'target.json', 'scope.json']]
            source.write_text(json.dumps(fixture())); source.chmod(0o600)
            scope.write_text(json.dumps(SCOPE))
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(MOD.main(['--input', str(source), '--output', str(target), '--scope-file', str(scope)]), 0)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertNotIn('fake-', output.getvalue())
            existing = target.read_bytes()
            with self.assertRaises(FileExistsError): MOD.main(['--input', str(source), '--output', str(target), '--scope-file', str(scope)])
            self.assertEqual(target.read_bytes(), existing)
            link = directory / 'link.json'; link.symlink_to(source)
            with self.assertRaises(OSError): MOD.protected_read(link)
            source.chmod(0o644)
            with self.assertRaises(ValueError): MOD.protected_read(source)

if __name__ == '__main__': unittest.main()
