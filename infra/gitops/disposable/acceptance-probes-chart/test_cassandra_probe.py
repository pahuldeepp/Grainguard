"""Fixture-state unit checks; exact driver/socket proof is opt-in Docker smoke."""
import importlib.util
from pathlib import Path
import ssl
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

PATH = Path(__file__).parent / 'files/cassandra-roundtrip.py'

class AuthenticationFailed(Exception): pass
class Unauthorized(Exception): pass
class NoHostAvailable(Exception):
    def __init__(self, cause): self.errors = {'fixture': cause}

class Endpoint:
    def __init__(self, *args): self.arguments = args

class CassandraProbeTests(unittest.TestCase):
    def load_probe(self):
        modules = {name: ModuleType(name) for name in ['cassandra', 'cassandra.auth', 'cassandra.cluster', 'cassandra.connection', 'cassandra.policies']}
        modules['cassandra'].__version__ = '3.29.0'
        modules['cassandra'].AuthenticationFailed = AuthenticationFailed
        modules['cassandra'].Unauthorized = Unauthorized
        modules['cassandra.auth'].PlainTextAuthProvider = lambda user,password: (user,password)
        modules['cassandra.cluster'].NoHostAvailable = NoHostAvailable
        modules['cassandra.cluster'].Cluster = lambda **kwargs: kwargs
        modules['cassandra.connection'].EndPointFactory = object
        modules['cassandra.connection'].SniEndPoint = Endpoint
        modules['cassandra.policies'].RoundRobinPolicy = object
        spec = importlib.util.spec_from_file_location('unit_cql_probe', PATH)
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, modules): spec.loader.exec_module(module)
        return module

    def auth(self, root):
        (root / 'writer-password').write_text('fake_writer_' + 'a' * 32)
        (root / 'reader-password').write_text('fake_reader_' + 'b' * 32)

    def test_all_real_connection_configuration_pins_dns_tls_and_refuses_peers(self):
        module = self.load_probe()
        context = ssl.create_default_context()
        cluster = SimpleNamespace(connect=lambda: SimpleNamespace(), shutdown=lambda: None)
        with tempfile.TemporaryDirectory() as temp:
            self.auth(Path(temp))
            with patch.dict(module.os.environ, CASSANDRA_AUTH_DIR=temp), patch.object(module.ssl, 'create_default_context', return_value=context), patch.object(module, 'Cluster', return_value=cluster) as factory:
                module.connection('writer')
                kwargs = factory.call_args.kwargs
                self.assertEqual(kwargs['contact_points'][0].arguments, ('greenguard-cassandra','greenguard-cassandra',9042))
                self.assertIs(kwargs['ssl_context'], context)
                self.assertTrue(context.check_hostname)
                self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
                self.assertEqual(kwargs['auth_provider'][0], 'gg_history_writer')
                self.assertFalse(cluster.schema_metadata_enabled)
                self.assertFalse(cluster.token_metadata_enabled)
                with self.assertRaisesRegex(RuntimeError, 'refuses discovered'): kwargs['endpoint_factory'].create({'peer':'untrusted'})

    def test_main_fixture_readback_denial_ttl_and_cleanup_fail_closed(self):
        for mode in ['ok', 'ttl', 'tenant', 'reader-write', 'anonymous', 'cleanup']:
            module = self.load_probe(); records = {}; closed = []
            class Session:
                def __init__(self, role): self.role = role
                def execute(self, query, values=None):
                    if query.startswith('SELECT probe_id'): return []
                    if query.startswith('INSERT'):
                        if self.role == 'reader' and mode != 'reader-write': raise Unauthorized()
                        records[tuple(values[:2])] = values[2]; return []
                    if query.startswith('DELETE'):
                        if mode == 'cleanup': raise RuntimeError('cleanup refused')
                        records.pop(tuple(values),None); return []
                    marker = records.get(tuple(values))
                    if marker is None: return []
                    if mode == 'tenant' and self.role == 'reader': marker = 'wrong-tenant'
                    return [SimpleNamespace(marker=marker,remaining=-1 if mode=='ttl' else 120)]
            def connect(role=None):
                if role is None:
                    if mode == 'anonymous': return SimpleNamespace(shutdown=lambda: closed.append('anonymous')),Session(None)
                    raise NoHostAvailable(AuthenticationFailed())
                return SimpleNamespace(shutdown=lambda: closed.append(role)),Session(role)
            with tempfile.TemporaryDirectory() as temp:
                self.auth(Path(temp))
                with self.subTest(mode=mode), patch.dict(module.os.environ,CASSANDRA_AUTH_DIR=temp,PROBE_READY_ATTEMPTS='1'), patch.object(module,'connection',side_effect=connect):
                    if mode == 'ok': module.main(); self.assertEqual(records,{})
                    else:
                        with self.assertRaises(RuntimeError): module.main()
                    self.assertIn('writer',closed)
                    if mode != 'anonymous': self.assertIn('reader',closed)

if __name__ == '__main__': unittest.main()
