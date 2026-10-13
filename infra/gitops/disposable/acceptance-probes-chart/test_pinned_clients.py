"""Opt-in isolated Docker proof for the exact owned public client images.

No host ports, shared volumes, AWS, private credentials or dependency installs.
Run GG_PINNED_CLIENT_SMOKE=1 python3 -m unittest ... -p test_pinned_clients.py.
"""
import atexit
import importlib.util
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid
import xml.etree.ElementTree as ET

CHART = Path(__file__).resolve().parent
BASE = CHART.parent
CH_IMAGE = 'clickhouse/clickhouse-server@sha256:157423fca52f596b62a1bf301b037b9f74bfca38089aa57d1bd36c9025f7ecef'
CQL_IMAGE = 'cassandra@sha256:8b55dd41d5d1220e11eb8cf80f26ab655c21f7cf271ca4a7577c1da7d9221624'
ENABLED = os.environ.get('GG_PINNED_CLIENT_SMOKE') == '1'

class PinnedClients(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not ENABLED:
            raise unittest.SkipTest('opt-in exact-image Docker smoke')
        cls.temp = tempfile.TemporaryDirectory(prefix='gg-task2-pinned-')
        cls.directory = Path(cls.temp.name)
        cls.prefix = 'gg-task2-pinned-' + uuid.uuid4().hex[:10]
        cls.containers, cls.networks = [], []
        cls.addClassCleanup(cls.cleanup)
        atexit.register(cls.cleanup)

    @classmethod
    def cleanup(cls):
        for container in reversed(cls.containers):
            subprocess.run(['docker', 'rm', '-f', '-v', container], capture_output=True)
        for network in reversed(cls.networks):
            subprocess.run(['docker', 'network', 'rm', network], capture_output=True)
        cls.temp.cleanup()

    def docker(self, *args, timeout=120, check=True):
        result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout)
        if check and result.returncode:
            # Tests use invented credentials; limit diagnostic volume.
            self.fail(result.stderr[-1600:])
        return result

    def network(self, suffix):
        name = self.prefix + '-' + suffix
        self.docker('network', 'create', '--internal', '--label', 'greenguard.io/test-owner=' + self.prefix, name)
        self.networks.append(name)
        return name

    def server(self, suffix, network, image, alias, *extra, command=()):
        name = self.prefix + '-' + suffix
        self.containers.append(name)
        self.docker('run', '-d', '--name', name, '--label', 'greenguard.io/test-owner=' + self.prefix,
                    '--platform', 'linux/amd64', '--network', network, '--network-alias', alias,
                    '--cpus=2', '--memory=2g', '--pids-limit=512', *extra, image, *command)
        return name

    def test_clickhouse_actual_native_client_readonly_rendered_entrypoint(self):
        network = self.network('ch')
        root = self.directory / 'ch'; root.mkdir()
        script = root / 'clickhouse-roundtrip.sh'; shutil.copyfile(CHART / 'files/clickhouse-roundtrip.sh', script); script.chmod(0o444)
        envfile = root / 'env'; envfile.write_text('CLICKHOUSE_USER=gg_probe\nCLICKHOUSE_PASSWORD=fake<>&"special_password_for_probe\nCLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1\n'); envfile.chmod(0o600)
        settings = root / 'bounded.xml'
        settings.write_text('<clickhouse><background_schedule_pool_size>16</background_schedule_pool_size><background_buffer_flush_schedule_pool_size>4</background_buffer_flush_schedule_pool_size><background_message_broker_schedule_pool_size>4</background_message_broker_schedule_pool_size><background_distributed_schedule_pool_size>4</background_distributed_schedule_pool_size><max_thread_pool_size>128</max_thread_pool_size></clickhouse>')
        settings.chmod(0o444)
        self.server('ch-server', network, CH_IMAGE, 'greenguard-clickhouse.greenguard.svc.cluster.local', '--env-file', str(envfile), '--mount', f'type=bind,source={settings},target=/etc/clickhouse-server/config.d/task-smoke-bounds.xml,readonly')
        # This is the exact rendered command/args, UID, readonly mount and
        # scratch volume; executing the 0444 script as command text would fail.
        client = self.prefix + '-ch-client'; self.containers.append(client)
        result = self.docker('run', '--rm', '--name', client, '--label', 'greenguard.io/test-owner=' + self.prefix, '--platform', 'linux/amd64', '--network', network,
                             '--cpus=0.5', '--memory=256m', '--pids-limit=128', '--user=101:101',
                             '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                             '--tmpfs', '/tmp:uid=101,gid=101,mode=0700', '--env-file', str(envfile),
                             '--mount', f'type=bind,source={root},target=/probe,readonly',
                             '--entrypoint', '/bin/bash', CH_IMAGE, '/probe/clickhouse-roundtrip.sh', timeout=240)
        self.assertIn('PASS clickhouse-roundtrip:', result.stdout)
        # Exact owned build and native listener were exercised; curl is absent.
        tools = self.docker('run', '--rm', '--platform', 'linux/amd64', '--network=none', '--cpus=0.5', '--memory=128m', '--entrypoint', '/bin/bash', CH_IMAGE,
                            '-ec', 'clickhouse-client --version; command -v curl && exit 1 || test $? = 1')
        self.assertIn('25.3.6.56', tools.stdout)
        self.docker('rm', '-f', '-v', self.prefix + '-ch-server')

    def certificates(self, root):
        def openssl(*args): subprocess.run(['openssl', *args], capture_output=True, check=True)
        openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=gg-task2-ca', '-keyout', str(root / 'ca.key'), '-out', str(root / 'ca.crt'))
        for name, dns in [('good', 'greenguard-cassandra'), ('bad', 'wrong.greenguard.example')]:
            openssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=' + dns, '-keyout', str(root / (name + '.key')), '-out', str(root / (name + '.csr')))
            extension = root / (name + '.ext'); extension.write_text('subjectAltName=DNS:' + dns + '\n')
            openssl('x509', '-req', '-days', '1', '-in', str(root / (name + '.csr')), '-CA', str(root / 'ca.crt'), '-CAkey', str(root / 'ca.key'), '-CAcreateserial', '-extfile', str(extension), '-out', str(root / (name + '.crt')))
        openssl('pkcs12', '-export', '-inkey', str(root / 'good.key'), '-in', str(root / 'good.crt'), '-certfile', str(root / 'ca.crt'), '-name', 'cassandra', '-passout', 'pass:fake_task2_keystore', '-out', str(root / 'server.p12'))
        for file in root.iterdir(): file.chmod(0o444)
        (root / 'writer-password').write_text('fake_writer_' + 'a' * 32)
        (root / 'reader-password').write_text('fake_reader_' + 'b' * 32)
        (root / 'writer-password').chmod(0o444); (root / 'reader-password').chmod(0o444)

    def probe_container(self, network, root, *args, check=True, timeout=120):
        name = self.prefix + '-client-' + uuid.uuid4().hex[:8]
        self.containers.append(name)
        return self.docker('run', '--rm', '--name', name, '--label', 'greenguard.io/test-owner=' + self.prefix, '--platform', 'linux/amd64', '--network', network,
                           '--cpus=0.5', '--memory=256m', '--pids-limit=128', '--user=999:999', '--read-only',
                           '--cap-drop=ALL', '--security-opt=no-new-privileges', '--tmpfs', '/tmp:uid=999,gid=999,mode=0700',
                           '--env', 'PYTHONDONTWRITEBYTECODE=1', '--env', 'PROBE_READY_ATTEMPTS=1',
                           '--mount', f'type=bind,source={root},target=/auth,readonly',
                           '--mount', f'type=bind,source={root},target=/cql-tls,readonly',
                           '--mount', f'type=bind,source={root / "probes"},target=/probe,readonly',
                           '--entrypoint', 'python3', CQL_IMAGE, *args, check=check, timeout=timeout)

    def test_cassandra_real_roundtrip_and_same_ca_wrong_san_query_path(self):
        root = self.directory / 'cql'; root.mkdir(); root.chmod(0o755)
        self.certificates(root)
        probes = root / 'probes'; probes.mkdir()
        script = probes / 'cassandra-roundtrip.py'; shutil.copyfile(CHART / 'files/cassandra-roundtrip.py', script); script.chmod(0o444)
        network = self.network('cql-good')
        config = self.docker('run', '--rm', '--platform', 'linux/amd64', '--network=none', '--cpus=0.5', '--memory=128m', '--entrypoint', 'cat', CQL_IMAGE, '/etc/cassandra/cassandra.yaml').stdout
        config = config.replace('rpc_address: localhost', 'rpc_address: 0.0.0.0').replace('broadcast_rpc_address: 1.2.3.4', 'broadcast_rpc_address: 127.0.0.1')
        config, changed = re.subn(r'(?m)^#?[ \t]*broadcast_rpc_address:.*$', 'broadcast_rpc_address: 127.0.0.1', config)
        if not changed: config += '\nbroadcast_rpc_address: 127.0.0.1\n'
        config = config.replace('authenticator: AllowAllAuthenticator', 'authenticator: PasswordAuthenticator').replace('authorizer: AllowAllAuthorizer', 'authorizer: CassandraAuthorizer')
        config = re.sub(r'(?ms)^client_encryption_options:\n.*?(?=^[^ #\n]|\Z)', 'client_encryption_options:\n  enabled: true\n  optional: false\n  keystore: /cql-tls/server.p12\n  keystore_password: fake_task2_keystore\n  store_type: PKCS12\n  require_client_auth: false\n', config)
        (root / 'cassandra.yaml').write_text(config); (root / 'cassandra.yaml').chmod(0o444)
        server = self.server('cql-server', network, CQL_IMAGE, 'greenguard-cassandra',
                             '--env', 'MAX_HEAP_SIZE=512M', '--env', 'HEAP_NEWSIZE=100M', '--env', 'CASSANDRA_NUM_TOKENS=8',
                             '--mount', f'type=bind,source={root},target=/cql-tls,readonly',
                             '--user=999:999', '--env', 'CASSANDRA_CONF=/tmp/cassandra', '--entrypoint', '/bin/sh',
                             command=('-ec', 'cp -r /etc/cassandra /tmp/cassandra; cp /cql-tls/cassandra.yaml /tmp/cassandra/cassandra.yaml; exec /opt/cassandra/bin/cassandra -f'))
        bootstrap = '''
import importlib.util,time
s=importlib.util.spec_from_file_location('probe','/probe/cassandra-roundtrip.py');p=importlib.util.module_from_spec(s);s.loader.exec_module(p)
from cassandra.auth import PlainTextAuthProvider
from cassandra.connection import SniEndPoint
from cassandra.cluster import Cluster
import ssl
c=ssl.create_default_context(cafile='/cql-tls/ca.crt');c.check_hostname=True
for attempt in range(90):
    cluster=Cluster(contact_points=[SniEndPoint('greenguard-cassandra','greenguard-cassandra',9042)],ssl_context=c,auth_provider=PlainTextAuthProvider('cassandra','cassandra'),protocol_version=4,connect_timeout=3)
    try: session=cluster.connect();break
    except Exception: cluster.shutdown();time.sleep(2)
else: raise RuntimeError('isolated Cassandra startup failed')
writer=open('/auth/writer-password').read().strip();reader=open('/auth/reader-password').read().strip()
for role,password in [('gg_history_writer',writer),('gg_history_reader',reader)]: session.execute("CREATE ROLE %s WITH PASSWORD = '%s' AND LOGIN = true" % (role,password))
session.execute("CREATE KEYSPACE greenguard_acceptance WITH replication = {'class':'SimpleStrategy','replication_factor':1}")
session.execute('CREATE TABLE greenguard_acceptance.probe (tenant_id uuid,probe_id uuid,marker text,PRIMARY KEY(tenant_id,probe_id)) WITH default_time_to_live = 120')
for role in ['gg_history_reader','gg_history_writer']: session.execute('GRANT SELECT ON TABLE greenguard_acceptance.probe TO '+role)
session.execute('GRANT MODIFY ON TABLE greenguard_acceptance.probe TO gg_history_writer')
cluster.shutdown();time.sleep(6)
print('isolated fixture roles/schema prepared')
'''
        self.probe_container(network, root, '-c', bootstrap, timeout=240)
        result = self.probe_container(network, root, '/probe/cassandra-roundtrip.py')
        self.assertIn('PASS cassandra-tenant-partition-roundtrip:', result.stdout)
        self.docker('rm', '-f', '-v', server)
        subprocess.run(['openssl', 'verify', '-CAfile', str(root / 'ca.crt'), str(root / 'bad.crt')], capture_output=True, check=True)
        # A separate isolated listener has a WRONG SAN signed by the SAME CA.
        # Invoke production connection('writer'): the real bundled driver must
        # reject it before sending STARTUP/auth bytes, not merely preflight it.
        badnet = self.network('cql-bad')
        listener = root / 'listener.py'
        listener.write_text("""import socket,ssl\nc=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);c.load_cert_chain('/auth/bad.crt','/auth/bad.key')\ns=socket.socket();s.bind(('0.0.0.0',9042));s.listen()\nwhile True:\n r,a=s.accept()\n try:\n  with c.wrap_socket(r,server_side=True) as t:\n   data=t.recv(4096);print('UNEXPECTED_CQL_BYTES='+str(len(data)),flush=True)\n except ssl.SSLError: print('TLS_REJECTED_BEFORE_CQL',flush=True)\n finally:r.close()\n""")
        bad = self.prefix + '-cql-wrong-san'; self.containers.append(bad)
        self.docker('run', '-d', '--name', bad, '--platform', 'linux/amd64', '--network', badnet, '--network-alias', 'greenguard-cassandra', '--cpus=0.5', '--memory=128m', '--pids-limit=128', '--mount', f'type=bind,source={root},target=/auth,readonly', '--entrypoint', 'python3', CQL_IMAGE, '/auth/listener.py')
        negative = '''import importlib.util,ssl
s=importlib.util.spec_from_file_location('probe','/probe/cassandra-roundtrip.py');p=importlib.util.module_from_spec(s);s.loader.exec_module(p)
from cassandra.cluster import NoHostAvailable
try:p.connection('writer')
except NoHostAvailable as e:
 # Bundled 3.29.0 wraps the socket's verification error in PermissionError.
 assert any('CERTIFICATE_VERIFY_FAILED' in str(c) and 'Hostname mismatch' in str(c) for c in e.errors.values()),'expected real hostname mismatch on credential session'
 print('PASS ACTUAL_CQL_WRONG_SAN_REJECTED')
else:raise RuntimeError('wrong SAN accepted')
'''
        time.sleep(1)
        result = self.probe_container(badnet, root, '-c', negative)
        self.assertIn('PASS ACTUAL_CQL_WRONG_SAN_REJECTED', result.stdout)
        logs = self.docker('logs', bad).stdout
        self.assertIn('TLS_REJECTED_BEFORE_CQL', logs)
        self.assertNotIn('UNEXPECTED_CQL_BYTES', logs)

if __name__ == '__main__': unittest.main()
