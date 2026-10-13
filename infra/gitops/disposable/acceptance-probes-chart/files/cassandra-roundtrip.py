"""Fixture-only CQL with hostname checking on every actual driver socket.

The owned Cassandra 5.0.5 image bundles driver 3.29.0 in its cqlsh zip.
SniEndPoint keeps the service DNS as server_hostname after IP resolution.
Peer discovery is refused: this chart owns one disposable Cassandra server.
"""
import logging
import os
from pathlib import Path
import re
import ssl
import sys
import time
import uuid

DRIVER = '/opt/cassandra/lib/cassandra-driver-internal-only-3.29.0.zip/cassandra-driver-3.29.0'
sys.path.insert(0, DRIVER)
import cassandra
from cassandra import AuthenticationFailed, Unauthorized
from cassandra.auth import PlainTextAuthProvider
from cassandra.cluster import Cluster, NoHostAvailable
from cassandra.connection import EndPointFactory, SniEndPoint
from cassandra.policies import RoundRobinPolicy

if cassandra.__version__ != '3.29.0':
    raise RuntimeError('owned Cassandra image driver contract drifted')
# Driver exceptions can include authentication metadata. Emit fixed errors.
logging.getLogger('cassandra').setLevel(logging.CRITICAL)
HOST = 'greenguard-cassandra'
TABLE = 'greenguard_acceptance.probe'

class RejectPeers(EndPointFactory):
    def create(self, row):
        raise RuntimeError('disposable acceptance refuses discovered peer endpoints')


def connection(role=None):
    context = ssl.create_default_context(cafile=os.environ.get('CASSANDRA_CA_FILE', '/cql-tls/ca.crt'))
    context.verify_mode = ssl.CERT_REQUIRED
    context.check_hostname = True
    auth = None
    if role is not None:
        password = Path(os.environ.get('CASSANDRA_AUTH_DIR', '/auth'), role + '-password').read_text().strip()
        if not re.fullmatch(r'[A-Za-z0-9_-]{16,128}', password):
            raise RuntimeError('invalid runtime CQL credential profile')
        auth = PlainTextAuthProvider('gg_history_' + role, password)
    # SNI belongs to the connection endpoint itself, so it applies to control
    # sockets, session pools and every reconnect before authentication bytes.
    cluster = Cluster(contact_points=[SniEndPoint(HOST, HOST, 9042)],
                      endpoint_factory=RejectPeers(), ssl_context=context,
                      auth_provider=auth, load_balancing_policy=RoundRobinPolicy(),
                      protocol_version=4, connect_timeout=5,
                      control_connection_timeout=10, idle_heartbeat_interval=0,
                      monitor_reporting_enabled=False)
    cluster.schema_metadata_enabled = False
    cluster.token_metadata_enabled = False
    try:
        session = cluster.connect()
        session.default_timeout = 20
        return cluster, session
    except BaseException:
        cluster.shutdown()
        raise


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    auth_dir = Path(os.environ.get('CASSANDRA_AUTH_DIR', '/auth'))
    require((auth_dir / 'writer-password').read_text().strip() !=
            (auth_dir / 'reader-password').read_text().strip(), 'writer/reader credentials must differ')
    writer_cluster = reader_cluster = None
    for attempt in range(int(os.environ.get('PROBE_READY_ATTEMPTS', '36'))):
        try:
            writer_cluster, writer = connection('writer')
            writer.execute('SELECT probe_id FROM ' + TABLE + ' LIMIT 1')
            break
        except Exception:
            if writer_cluster is not None:
                writer_cluster.shutdown()
                writer_cluster = None
            if attempt == int(os.environ.get('PROBE_READY_ATTEMPTS', '36')) - 1:
                raise RuntimeError('authenticated hostname-verified CQL fixture unavailable') from None
            time.sleep(5)
    try:
        try:
            anonymous_cluster, anonymous = connection()
        except NoHostAvailable as error:
            require(any(isinstance(cause, AuthenticationFailed) for cause in error.errors.values()),
                    'anonymous CQL failure was not an authentication denial')
        else:
            anonymous_cluster.shutdown()
            raise RuntimeError('anonymous CQL authentication was accepted')
        reader_cluster, reader = connection('reader')
        tenant_a, tenant_b, probe_id, denied_id = [uuid.uuid4() for _ in range(4)]
        marker_a, marker_b = 'marker-' + str(probe_id), 'other-' + str(probe_id)
        inserted = []
        try:
            for tenant, marker in [(tenant_a, marker_a), (tenant_b, marker_b)]:
                inserted.append((tenant, probe_id))
                writer.execute('INSERT INTO ' + TABLE + ' (tenant_id, probe_id, marker) VALUES (%s, %s, %s) USING TTL 120', (tenant, probe_id, marker))
            rows = list(writer.execute('SELECT marker, TTL(marker) AS remaining FROM ' + TABLE + ' WHERE tenant_id = %s AND probe_id = %s', (tenant_a, probe_id)))
            require(len(rows) == 1 and rows[0].marker == marker_a and 0 < rows[0].remaining <= 120,
                    'writer readback or bounded TTL failed')
            for tenant, marker in [(tenant_a, marker_a), (tenant_b, marker_b)]:
                rows = list(reader.execute('SELECT marker FROM ' + TABLE + ' WHERE tenant_id = %s AND probe_id = %s', (tenant, probe_id)))
                require(len(rows) == 1 and rows[0].marker == marker, 'reader tenant partition readback failed')
            inserted.append((tenant_a, denied_id))
            try:
                reader.execute('INSERT INTO ' + TABLE + ' (tenant_id, probe_id, marker) VALUES (%s, %s, %s) USING TTL 120', (tenant_a, denied_id, 'reader-must-not-write'))
            except Unauthorized:
                pass
            else:
                raise RuntimeError('reader role was allowed to write')
            require(not list(writer.execute('SELECT marker FROM ' + TABLE + ' WHERE tenant_id = %s AND probe_id = %s', (tenant_a, denied_id))), 'refused reader write is present')
        finally:
            for tenant, record in inserted:
                writer.execute('DELETE FROM ' + TABLE + ' WHERE tenant_id = %s AND probe_id = %s', (tenant, record))
                require(not list(writer.execute('SELECT marker FROM ' + TABLE + ' WHERE tenant_id = %s AND probe_id = %s', (tenant, record))), 'fixture survived cleanup')
        print('PASS cassandra-tenant-partition-roundtrip: every CQL socket validates CA/DNS; AUTH, TTL, tenant reads, reader denial and cleanup verified')
    finally:
        if reader_cluster is not None:
            reader_cluster.shutdown()
        writer_cluster.shutdown()

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('FAIL cassandra-tenant-partition-roundtrip: verified CQL operation, auth/isolation or cleanup failed', file=sys.stderr)
        raise SystemExit(1)
