"""Offline chart contracts and failure-path execution. Never live proof."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from test_chart import fixture, render, CHART

IDS = {'kafka-produce-consume', 'redis-tenant-cache-roundtrip',
       'cassandra-tenant-partition-roundtrip', 'opensearch-index-search'}


def data_fixture():
    value = fixture()
    value.update(dataPlaneEnabled=True, kafkaImage='example.test/kafka@sha256:' + 'd' * 64,
                 redisImage='example.test/redis@sha256:' + 'e' * 64,
                 cassandraImage='example.test/cassandra@sha256:' + 'f' * 64)
    return value


class DataChartTests(unittest.TestCase):
    def test_all_service_jobs_are_bounded_owned_and_scoped(self):
        objects = render(data_fixture())
        jobs = {obj['metadata']['labels']['greenguard.io/acceptance-probe']: obj for obj in objects if obj['kind'] == 'Job'}
        self.assertEqual(set(jobs), IDS | {'clickhouse-roundtrip', 'tenant-membership-readback'})
        for name in IDS:
            job = jobs[name]
            pod = job['spec']['template']['spec']
            self.assertGreater(job['spec']['activeDeadlineSeconds'], 0)
            self.assertFalse(pod['automountServiceAccountToken'])
            self.assertTrue(pod['securityContext']['runAsNonRoot'])
            container = pod['containers'][0]
            self.assertTrue(container['securityContext']['readOnlyRootFilesystem'])
            self.assertEqual(container['securityContext']['capabilities']['drop'], ['ALL'])
            self.assertTrue(any(v.get('emptyDir') == {} for v in pod['volumes']))
            serialized = json.dumps(pod)
            self.assertNotIn('admin-password', serialized)
            self.assertNotIn('node.key', serialized)
            self.assertNotIn('server.p12', serialized)
        kafka_env = jobs['kafka-produce-consume']['spec']['template']['spec']['containers'][0]['env'][0]
        self.assertEqual(kafka_env['valueFrom']['secretKeyRef'], {'name': 'greenguard-kafka-auth', 'key': 'acceptance-client-jaas'})
        self.assertEqual(jobs['opensearch-index-search']['spec']['template']['spec']['containers'][0]['image'], data_fixture()['cassandraImage'])

    def test_rendered_entrypoint_and_native_transport_permissions(self):
        objects = render(data_fixture())
        job = next(x for x in objects if x['kind'] == 'Job' and x['metadata']['labels']['greenguard.io/acceptance-probe'] == 'clickhouse-roundtrip')
        container = job['spec']['template']['spec']['containers'][0]
        self.assertEqual(job['spec']['template']['spec']['securityContext']['fsGroup'], 101)
        self.assertEqual(container['command'] + container['args'], ['/bin/bash', '/probe/clickhouse-roundtrip.sh'])
        policy = next(x for x in objects if x['kind'] == 'NetworkPolicy' and x['metadata']['name'] == 'greenguard-clickhouse-acceptance-ingress')
        self.assertEqual(policy['spec']['ingress'][0]['ports'], [{'protocol': 'TCP', 'port': 9000}])
        auth = next(x for x in objects if x['kind'] == 'AuthorizationPolicy' and x['metadata']['name'] == 'clickhouse-native-acceptance')
        self.assertEqual(auth['spec']['rules'][1]['from'][0]['source']['principals'], ['cluster.local/ns/greenguard/sa/greenguard-live-acceptance-probes'])
        self.assertEqual(auth['spec']['rules'][1]['to'][0]['operation']['ports'], ['9000'])
        sink = subprocess.run(['helm','template','telemetry-clickhouse-sink',str(CHART.parents[2] / 'helm/greenguard-service'),'--namespace','greenguard','-f',str(CHART.parents[2] / 'helm/greenguard-service/values/telemetry-clickhouse-sink.yaml'),'--set','image='+data_fixture()['clickhouseImage']],capture_output=True,text=True,check=True)
        import re
        service_account = re.search(r'serviceAccountName: (\S+)',sink.stdout).group(1)
        self.assertEqual(auth['spec']['rules'][0]['from'][0]['source']['principals'], ['cluster.local/ns/greenguard/sa/'+service_account])

    def test_server_wave_owns_istiod_egress_and_private_native_listener(self):
        chart = CHART.parent / 'clickhouse-chart'
        import tempfile, subprocess
        values = {'image': data_fixture()['clickhouseImage']}
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'values.json'; path.write_text(json.dumps(values))
            result = subprocess.run(['helm', 'template', 'ch', str(chart), '--namespace', 'greenguard', '-f', str(path)], capture_output=True, text=True, check=True)
            parsed = subprocess.run(['ruby', '-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.load_stream(STDIN.read).compact)'], input=result.stdout, capture_output=True, text=True, check=True)
        objects = json.loads(parsed.stdout)
        service = next(x for x in objects if x['kind'] == 'Service')
        self.assertEqual(service['spec']['type'], 'ClusterIP')
        self.assertEqual({p['port'] for p in service['spec']['ports']}, {8123, 9000})
        server = next(x for x in objects if x['kind'] == 'StatefulSet')
        policy = next(x for x in objects if x['kind'] == 'NetworkPolicy' and x['metadata']['name'] == 'greenguard-clickhouse')
        selector = policy['spec']['podSelector']['matchLabels']
        self.assertTrue(all(server['spec']['template']['metadata']['labels'][k] == v for k,v in selector.items()))
        rule = policy['spec']['egress'][0]
        self.assertEqual(rule['to'][0], {'namespaceSelector': {'matchLabels': {'kubernetes.io/metadata.name': 'istio-system'}}, 'podSelector': {'matchLabels': {'app': 'istiod'}}})
        self.assertEqual(rule['ports'], [{'protocol': 'TCP', 'port': 15012}])
        self.assertEqual(policy['spec']['ingress'][0]['ports'], [{'protocol': 'TCP', 'port': 8123}])
        source = (CHART.parent / 'applications-chart/templates/clickhouse-application.yaml').read_text()
        self.assertIn('sync-wave: "28"', source)

    def test_missing_mutable_or_wrong_type_inputs_are_rejected(self):
        for key in ['kafkaImage', 'redisImage', 'cassandraImage']:
            for invalid in ['', 'example.test/fixture:latest']:
                value = data_fixture()
                value[key] = invalid
                with self.subTest(key=key, invalid=invalid), self.assertRaises(ValueError):
                    render(value)
        for key in ['dataPlaneEnabled', 'clickhouseEnabled', 'membershipEnabled']:
            value = data_fixture()
            value[key] = 'false'
            with self.subTest(key=key), self.assertRaises(ValueError):
                render(value)

    def test_cassandra_network_path_preserves_auth_activation_gate(self):
        objects = render(data_fixture())
        policy = next(x for x in objects if x['kind'] == 'NetworkPolicy' and x['metadata']['name'] == 'acceptance-cassandra-tenant-partition-roundtrip-ingress')
        self.assertEqual(policy['spec']['podSelector']['matchLabels']['greenguard.io/cassandra-auth-ready'], 'true')
        self.assertEqual(policy['spec']['ingress'][0]['from'][0]['podSelector']['matchLabels']['greenguard.io/acceptance-probe'], 'cassandra-tenant-partition-roundtrip')
        job = next(x for x in objects if x['kind'] == 'Job' and x['metadata']['labels']['greenguard.io/acceptance-probe'] == 'cassandra-tenant-partition-roundtrip')
        self.assertEqual(job['spec']['template']['metadata']['annotations']['sidecar.istio.io/inject'], 'false')

    def test_mesh_tls_pins_destination_service_identity(self):
        objects = render(data_fixture())
        peers = [x for x in objects if x['kind'] == 'PeerAuthentication']
        self.assertEqual(len(peers), 2)
        self.assertTrue(all(x['spec']['mtls']['mode'] == 'STRICT' for x in peers))
        destinations = [x for x in objects if x['kind'] == 'DestinationRule']
        self.assertEqual(len(destinations), 2)
        for destination in destinations:
            self.assertEqual(destination['spec']['trafficPolicy']['tls'], {'mode': 'ISTIO_MUTUAL', 'subjectAltNames': ['spiffe://cluster.local/ns/greenguard/sa/default']})
            self.assertEqual(destination['spec']['workloadSelector']['matchLabels'], {'app.kubernetes.io/name': 'greenguard-live-acceptance-probes'})
        data = next(x for x in objects if x['kind'] == 'ConfigMap')['data']
        for text in data.values():
            self.assertNotIn('--insecure', text)
            self.assertNotIn('CERT_NONE', text)
            self.assertNotIn('SSL_VALIDATE=false', text)

    def test_data_flag_is_independent_and_scripts_change_job_revision(self):
        values = data_fixture()
        values.update(clickhouseEnabled=False, membershipEnabled=False)
        self.assertEqual({x['metadata']['labels']['greenguard.io/acceptance-probe'] for x in render(values) if x['kind'] == 'Job'}, IDS)
        source = (CHART / 'templates/data-probes.yaml').read_text()
        self.assertIn('.Files.Glob "files/*"', source)


# A CLI model lets the real shell assertions execute on this host; no service
# or TLS handshake is fabricated as live evidence. Each negative case changes
# a response so the production script must reject it.
CLI = r'''
import json, os, pathlib, re, sys, uuid
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
failure = os.environ.get('MOCK_FAIL', '')
state_file = pathlib.Path(os.environ['MOCK_STATE'])
state = json.loads(state_file.read_text()) if state_file.exists() else {}
def save(): state_file.write_text(json.dumps(state))
if name == 'cat':
    if args == ['/proc/sys/kernel/random/uuid']: print(uuid.uuid4()); sys.exit(0)
    if not args: sys.stdout.write(sys.stdin.read())
    for file in args: sys.stdout.write(pathlib.Path(file).read_text())
elif name == 'sleep': pass
elif name == 'redis-cli':
    if not os.environ.get('REDISCLI_AUTH'):
        print('PONG' if failure == 'anonymous' else 'NOAUTH Authentication required.'); sys.exit(0)
    args = args[args.index('--raw') + 1:]
    op = args[0].upper()
    if op == 'CLUSTER': print('cluster_state:fail' if failure == 'ready' else 'cluster_state:ok')
    elif op == 'SET': state[args[1]] = args[2]; save(); print('OK')
    elif op == 'GET': print('wrong' if failure == 'read' else state.get(args[1], ''))
    elif op == 'TTL': print(-1 if failure == 'ttl' else 120)
    elif op == 'DEL':
        if failure == 'cleanup': print(0)
        else: print(1 if state.pop(args[1], None) is not None else 0); save()
    elif op == 'EXISTS': print(int(args[1] in state))
elif name == 'clickhouse-client':
    if '--query' in args:
        if failure == 'ready': sys.exit(1)
        print(1)
    elif '--queries-file' in args:
        query = pathlib.Path(args[args.index('--queries-file') + 1]).read_text()
        if failure in {'read','tenant','cleanup'}: sys.exit(1)
        assert 'CREATE TEMPORARY TABLE' in query and 'DROP TEMPORARY TABLE' in query
        assert query.count('SELECT throwIf') == 3
elif name == 'kafka-topics.sh':
    if failure == 'ready': sys.exit(1)
    print('Topic: greenguard.acceptance.probe.v1')
elif name == 'kafka-console-producer.sh':
    topic = args[args.index('--topic') + 1]
    record = sys.stdin.read().strip()
    if topic == 'greenguard.acceptance.denied.v1':
        if failure == 'write-denial': sys.exit(0)
        print('TopicAuthorizationException: ' + topic, file=sys.stderr); sys.exit(1)
    if failure == 'write': print('ERROR produce failed', file=sys.stderr); sys.exit(1)
    state['record'] = record; save()
elif name == 'kafka-console-consumer.sh':
    topic = args[args.index('--topic') + 1]
    if topic == 'greenguard.telemetry.recorded.v2':
        if failure == 'read-denial': print('unexpected-domain-data')
        else: print('TopicAuthorizationException: ' + topic, file=sys.stderr)
        sys.exit(1)
    print('wrong' if failure == 'read' else state.get('record', ''))
    sys.exit(1)
'''


class ShellProbeTests(unittest.TestCase):
    def run_probe(self, service, failure=''):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            for name in ['cat', 'sleep', 'redis-cli', 'clickhouse-client', 'kafka-topics.sh', 'kafka-console-producer.sh', 'kafka-console-consumer.sh']:
                file = directory / name
                file.write_text('#!' + sys.executable + '\n' + CLI)
                file.chmod(0o755)
            (directory / 'ca.crt').write_text('mock-ca')
            (directory / 'writer-password').write_text('writer_' + 'a' * 32)
            (directory / 'reader-password').write_text('reader_' + 'b' * 32)
            if failure == 'missing-ca': (directory / 'ca.crt').unlink()
            env = dict(os.environ, KAFKA_CA_FILE=str(directory / 'ca.crt'), KAFKA_BIN=str(directory),
                       KAFKA_SASL_JAAS_CONFIG='org.apache.kafka.common.security.plain.PlainLoginModule required username="acceptance-probe" password="fake-password";',
                       CASSANDRA_CA_FILE=str(directory / 'ca.crt'), CASSANDRA_AUTH_DIR=str(directory), PATH=str(directory) + os.pathsep + os.environ['PATH'],
                       MOCK_STATE=str(directory / 'state.json'), MOCK_FAIL=failure,
                       PROBE_READY_ATTEMPTS='1', PROBE_WORK_DIR=str(directory),
                       REDISCLI_AUTH='fake-password', CLICKHOUSE_USER='fake-user', CLICKHOUSE_PASSWORD='fake-password')
            result = subprocess.run(['bash' if service == 'clickhouse' else 'sh', str(CHART / 'files' / f'{service}-roundtrip.sh')], env=env, capture_output=True, text=True, timeout=10)
            self.assertNotIn('fake-password', result.stdout + result.stderr)
            return result

    def test_redis_success_and_absent_auth_read_ttl_cleanup_failures(self):
        self.assertEqual(self.run_probe('redis').returncode, 0)
        for failure in ['ready', 'anonymous', 'read', 'ttl', 'cleanup']:
            with self.subTest(failure=failure):
                self.assertNotEqual(self.run_probe('redis', failure).returncode, 0)

    def test_clickhouse_success_and_absent_read_tenant_cleanup_failures(self):
        self.assertEqual(self.run_probe('clickhouse').returncode, 0)
        for failure in ['ready', 'read', 'tenant', 'cleanup']:
            with self.subTest(failure=failure):
                self.assertNotEqual(self.run_probe('clickhouse', failure).returncode, 0)

    def test_kafka_success_and_ready_write_read_acl_or_missing_ca_failures(self):
        self.assertEqual(self.run_probe('kafka').returncode, 0)
        for failure in ['ready', 'write', 'read', 'write-denial', 'read-denial', 'missing-ca']:
            with self.subTest(failure=failure):
                self.assertNotEqual(self.run_probe('kafka', failure).returncode, 0)



class OpenSearchProbeTests(unittest.TestCase):
    def test_https_request_rejects_partial_shards_and_uses_ca_context(self):
        spec = importlib.util.spec_from_file_location('search_probe_tls', CHART / 'files/opensearch-roundtrip.py')
        module = importlib.util.module_from_spec(spec)
        with patch('ssl.create_default_context') as context:
            spec.loader.exec_module(module)
            context.assert_called_once_with(cafile='/search-ca/ca.crt')
        for result in [{'timed_out': True, '_shards': {'failed': 0}},
                       {'timed_out': False, '_shards': {'failed': 1}},
                       {'timed_out': False, '_shards': {'failed': 0}}]:
            response = unittest.mock.MagicMock()
            response.__enter__.return_value = response
            response.status = 200
            response.read.return_value = json.dumps(result).encode()
            with patch.object(module.urllib.request, 'urlopen', return_value=response) as urlopen:
                if result['timed_out'] or result['_shards']['failed']:
                    with self.assertRaises(RuntimeError): module.request('POST', '/greenguard-acceptance-probe-v1/_search', {'size': 0}, role=None)
                else: module.request('POST', '/greenguard-acceptance-probe-v1/_search', {'size': 0}, role=None)
                self.assertIs(urlopen.call_args.kwargs['context'], module.CONTEXT)
                self.assertEqual(urlopen.call_args.args[0].full_url, module.BASE + '/greenguard-acceptance-probe-v1/_search')

    def test_real_probe_rejects_empty_or_cross_tenant_search_and_cleans_up(self):
        path = CHART / 'files/opensearch-roundtrip.py'
        spec = importlib.util.spec_from_file_location('search_probe', path)
        module = importlib.util.module_from_spec(spec)
        with patch('ssl.create_default_context'):
            spec.loader.exec_module(module)
        for mode in ['success', 'missing', 'cross-tenant', 'reader-write', 'absent']:
            documents = {}
            cleanup = []
            def fake_request(method, path, payload=None, role='writer', expected=(200, 201)):
                if mode == 'absent': raise RuntimeError('service unavailable')
                if role is None: return {}
                if method == 'PUT':
                    if expected == (403,):
                        if mode == 'reader-write': raise RuntimeError('reader write unexpectedly accepted')
                        return {}
                    documents[path.split('?')[0]] = payload
                    return {}
                if method == 'DELETE':
                    cleanup.append(path); documents.pop(path.split('?')[0], None); return {}
                if method == 'GET': return {}
                if payload == {'size': 0}: return {}
                filters = payload['query']['bool']['filter']
                matches = [v for v in documents.values() if all(v.get(k) == value for entry in filters for k, value in entry['term'].items())]
                if mode == 'missing': matches = []
                if mode == 'cross-tenant': matches = list(documents.values())
                return {'hits': {'hits': [{'_source': v} for v in matches]}}
            with self.subTest(mode=mode), patch.object(module, 'request', side_effect=fake_request), patch.object(module.time, 'sleep'), patch.dict(os.environ, PROBE_READY_ATTEMPTS='1'):
                if mode == 'success': module.main()
                else:
                    with self.assertRaises(RuntimeError): module.main()
                if mode != 'absent': self.assertEqual(len(cleanup), 2)

if __name__ == '__main__': unittest.main()
