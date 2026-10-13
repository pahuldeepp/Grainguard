#!/usr/bin/env python3
"""Bounded local candidate tests; fresh credentials, isolated network, no host ports."""
import argparse
import json
import re
import secrets
import shutil
import subprocess
import time
from pathlib import Path

def run(command, *, timeout=60, ok=True, input=None):
    result = subprocess.run(command, input=input, text=True, capture_output=True, timeout=timeout)
    if ok and result.returncode:
        raise RuntimeError(f'{command[0:3]} failed ({result.returncode}): {result.stderr[-2000:]} {result.stdout[-2000:]}')
    return result



class OwnedResources:
    """Reserve collision-free names before creation and verify every removal."""
    label = 'io.greenguard.vendor-test-owner'

    def __init__(self, runner=run):
        self.runner = runner
        self.owner = secrets.token_hex(16)
        self.resources = {}

    @property
    def label_argument(self):
        return self.label + '=' + self.owner

    def inspect(self, kind, name):
        result = self.runner(['docker', kind, 'inspect', name], ok=False, timeout=15)
        if result.returncode:
            if result.returncode == 1 and ('no such' in result.stderr.lower() or 'not found' in result.stderr.lower()):
                return None
            raise RuntimeError(f'{kind} {name}: absence not established: {result.stderr[-400:]}')
        objects = json.loads(result.stdout)
        if not isinstance(objects, list) or len(objects) != 1:
            raise RuntimeError(f'{kind} {name}: invalid inspection')
        return objects[0]

    def reserve(self, kind, name):
        if kind not in ('container','volume','network'):
            raise ValueError('unsupported owned resource kind')
        if self.inspect(kind, name) is not None:
            raise RuntimeError(f'{kind} {name}: already exists; refusing reuse')
        entry = self.resources.setdefault((kind, name), {'kind': kind, 'name': name,
            'creationAttempts': 0, 'absentVerified': False, 'errors': []})
        entry['creationAttempts'] += 1
        entry['absentVerified'] = False

    def remove_one(self, kind, name):
        entry = self.resources[(kind, name)]
        try:
            obj = self.inspect(kind, name)
            if obj is not None:
                labels = obj.get('Config', {}).get('Labels') if kind == 'container' else obj.get('Labels')
                if not isinstance(labels, dict) or labels.get(self.label) != self.owner:
                    raise RuntimeError('ownership label differs; refusing removal')
                command = ['docker', kind, 'rm'] + (['-f','-v'] if kind == 'container' else []) + [name]
                try:
                    self.runner(command, timeout=30)
                except Exception as error:
                    entry['errors'].append('removal: '+str(error))
        except Exception as error:
            entry['errors'].append('inspection: '+str(error))
        # Verification is independent of logging/removal success and is attempted
        # even after a timeout. Other resources are always attempted as well.
        try:
            entry['absentVerified'] = self.inspect(kind, name) is None
            if not entry['absentVerified']:
                entry['errors'].append('resource remains after cleanup')
        except Exception as error:
            entry['errors'].append('verification: '+str(error))
        return entry['absentVerified'] and not entry['errors']

    def cleanup(self, collect_logs=None):
        log_errors = []
        if collect_logs is not None:
            for kind, name in list(self.resources):
                if kind == 'container':
                    try:
                        collect_logs(name)
                    except Exception as error:
                        log_errors.append(str(error))
        for kind in ('container','volume','network'):
            for resource_kind, name in list(self.resources):
                if resource_kind == kind:
                    self.remove_one(kind, name)
        records = list(self.resources.values())
        return {'owner': self.owner, 'cleanupComplete': not log_errors and all(x['absentVerified'] and not x['errors'] for x in records),
                'resources': records, 'logErrors': log_errors}


def release_version(result, expected):
    versions = re.findall(r'^\s*(\d+\.\d+\.\d+(?:[-+a-zA-Z0-9.]*)?)\s*$', result.stdout, re.MULTILINE)
    if result.returncode != 0 or versions != [expected]:
        raise RuntimeError(f'expected Cassandra {expected}; runtime query returned {versions!r}')
    return versions[0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('output', type=Path)
    parser.add_argument('run_id')
    parser.add_argument('--kafka-image', required=True)
    parser.add_argument('--service', choices=['all','kafka','cassandra'], default='all')
    parser.add_argument('--cassandra-image', required=True)
    parser.add_argument('--baseline-cassandra-image', default='cassandra@sha256:8b55dd41d5d1220e11eb8cf80f26ab655c21f7cf271ca4a7577c1da7d9221624')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{7,60}', args.run_id):
        raise SystemExit('invalid unique run identifier')
    # Resolve mutable local candidate tags once, then run their immutable IDs.
    if not re.fullmatch(r'[^\s@]+@sha256:[a-f0-9]{64}', args.baseline_cassandra_image):
        raise SystemExit('baseline Cassandra image must be pinned by OCI digest')
    image_evidence = {}
    for field in ('kafka_image','cassandra_image','baseline_cassandra_image'):
        reference = getattr(args, field)
        inspected = json.loads(run(['docker','image','inspect',reference]).stdout)
        if len(inspected) != 1 or not re.fullmatch(r'sha256:[a-f0-9]{64}', inspected[0]['Id']):
            raise RuntimeError('invalid local immutable image identity')
        image_evidence[field] = {'reference':reference,'digest':inspected[0]['Id']}
        setattr(args, field, inspected[0]['Id'])
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    fixture = output / 'fixtures'
    fixture.mkdir(mode=0o755)
    network = 'gg-vendor-' + args.run_id
    resources = OwnedResources()
    versions = {}
    (output/'images.json').write_text(json.dumps(image_evidence,indent=2)+'\n')
    checks = []
    password = secrets.token_hex(16)




    def check(name, condition, evidence=''):
        checks.append({'name': name, 'pass': bool(condition), 'evidence': evidence})
        (output / 'checks.json').write_text(json.dumps(checks, indent=2) + '\n')
        print(('PASS ' if condition else 'FAIL ') + name, flush=True)
        if not condition:
            raise RuntimeError(name + ': ' + evidence)


    def exec_in(container, command, **kwargs):
        flags = ['-i'] if kwargs.get('input') is not None else []
        return run(['docker', 'exec', *flags, container, *command], **kwargs)


    def wait_for(container, command, *, attempts=30, delay=3):
        for _ in range(attempts):
            result = exec_in(container, command, ok=False, timeout=20)
            if result.returncode == 0:
                return result
            state = run(['docker', 'inspect', '--format', '{{.State.Running}}', container]).stdout.strip()
            if state != 'true':
                break
            time.sleep(delay)
        raise RuntimeError('readiness deadline expired: ' + result.stderr[-2000:])


    def start(name, image, options, command=()):
        resources.reserve('container',name)
        run(['docker', 'run', '-d', '--pull','never','--name', name, '--label',resources.label_argument,'--network', network, '--cpus', '1',
             '--pids-limit', '256', '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL',
             *options, image, *command], timeout=180)
        expected_user = '1000:1000' if name.endswith('-kafka') else '999:999'
        check(name + ' runtime non-root', run(['docker', 'inspect', '--format', '{{.Config.User}}', name]).stdout.strip() == expected_user)
        if image in (args.kafka_image, args.cassandra_image):
            image_user = run(['docker', 'image', 'inspect', '--format', '{{.Config.User}}', image]).stdout.strip()
            check(name + ' candidate image non-root', image_user == expected_user, image_user)


    try:
        # Fresh CA signed fixture with hostname verification; nothing is read from deployment secrets.
        run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
             '-subj', '/CN=GreenGuard isolated vendor test CA',
             '-addext','basicConstraints=critical,CA:TRUE', '-addext','keyUsage=critical,keyCertSign,cRLSign', '-keyout', str(fixture/'ca.key'), '-out', str(fixture/'ca.crt')])
        run(['openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=kafka',
             '-keyout', str(fixture/'server.key'), '-out', str(fixture/'server.csr')])
        (fixture/'extensions').write_text('subjectAltName=DNS:kafka,DNS:cassandra,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth,clientAuth\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n')
        run(['openssl', 'x509', '-req', '-in', str(fixture/'server.csr'), '-CA', str(fixture/'ca.crt'),
             '-CAkey', str(fixture/'ca.key'), '-CAcreateserial', '-days', '2', '-extfile', str(fixture/'extensions'), '-out', str(fixture/'server.crt')])
        run(['openssl', 'pkcs12', '-export', '-in', str(fixture/'server.crt'), '-inkey', str(fixture/'server.key'),
             '-certfile', str(fixture/'ca.crt'), '-name', 'server', '-out', str(fixture/'server.p12'), '-passout', 'pass:'+password])
        # Only disposable test material is world readable, needed by both candidate UIDs.
        for file in fixture.iterdir():
            file.chmod(0o644)
        resources.reserve('container',network+'-keytool')
        run(['docker', 'run', '--rm','--pull','never','--label',resources.label_argument, '--name', network+'-keytool', '--network', 'none', '--cpus', '1', '--memory', '256m',
             '--pids-limit', '128', '--user', '0', '--mount', f'type=bind,src={fixture},dst=/fixture',
             '--entrypoint', 'keytool', args.kafka_image, '-importcert', '-noprompt', '-alias', 'ca', '-file', '/fixture/ca.crt',
             '-keystore', '/fixture/trust.p12', '-storetype', 'PKCS12', '-storepass', password])
        (fixture/'trust.p12').chmod(0o644)
        for user, secret in [('admin',password),('app',password),('outsider',password),('bad', 'incorrect-test-password')]:
            authuser = 'app' if user == 'bad' else user
            (fixture/f'{user}.properties').write_text(
                'security.protocol=SASL_SSL\nsasl.mechanism=PLAIN\n'
                f'sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required username="{authuser}" password="{secret}";\n'
                f'ssl.truststore.location=/fixture/trust.p12\nssl.truststore.password={password}\nssl.truststore.type=PKCS12\n'
                'ssl.endpoint.identification.algorithm=https\nrequest.timeout.ms=5000\ndefault.api.timeout.ms=10000\n')
        resources.reserve('network',network)
        run(['docker','network','create','--label',resources.label_argument,'--internal',network])
        if args.service in ('all','kafka'):
            kafka = network+'-kafka'
            env = {
                'CLUSTER_ID':'MkU3OEVBNTcwNTJENDM2Qk', 'KAFKA_NODE_ID':'1', 'KAFKA_PROCESS_ROLES':'broker,controller',
                'KAFKA_CONTROLLER_QUORUM_VOTERS':'1@kafka:9093', 'KAFKA_LISTENERS':'INTERNAL://:29092,CONTROLLER://:9093',
                'KAFKA_ADVERTISED_LISTENERS':'INTERNAL://kafka:29092', 'KAFKA_LISTENER_SECURITY_PROTOCOL_MAP':'INTERNAL:SASL_SSL,CONTROLLER:SASL_SSL',
                'KAFKA_CONTROLLER_LISTENER_NAMES':'CONTROLLER', 'KAFKA_INTER_BROKER_LISTENER_NAME':'INTERNAL',
                'KAFKA_AUTHORIZER_CLASS_NAME':'org.apache.kafka.metadata.authorizer.StandardAuthorizer',
                'KAFKA_ALLOW_EVERYONE_IF_NO_ACL_FOUND':'false', 'KAFKA_SUPER_USERS':'User:broker;User:admin',
                'KAFKA_SASL_ENABLED_MECHANISMS':'PLAIN', 'KAFKA_SASL_MECHANISM_INTER_BROKER_PROTOCOL':'PLAIN',
                'KAFKA_SASL_MECHANISM_CONTROLLER_PROTOCOL':'PLAIN', 'KAFKA_SSL_KEYSTORE_LOCATION':'/fixture/server.p12',
                'KAFKA_SSL_KEYSTORE_TYPE':'PKCS12', 'KAFKA_SSL_KEYSTORE_PASSWORD':password, 'KAFKA_SSL_KEY_PASSWORD':password,
                'KAFKA_SSL_TRUSTSTORE_LOCATION':'/fixture/trust.p12', 'KAFKA_SSL_TRUSTSTORE_TYPE':'PKCS12', 'KAFKA_SSL_TRUSTSTORE_PASSWORD':password,
                'KAFKA_SSL_CLIENT_AUTH':'none', 'KAFKA_AUTO_CREATE_TOPICS_ENABLE':'false', 'KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR':'1',
                'KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR':'1', 'KAFKA_TRANSACTION_STATE_LOG_MIN_ISR':'1',
                'KAFKA_MIN_INSYNC_REPLICAS':'1', 'KAFKA_DEFAULT_REPLICATION_FACTOR':'1', 'KAFKA_LOG_DIRS':'/tmp/kafka-data',
                'KAFKA_HEAP_OPTS':'-Xms256m -Xmx512m',
            }
            jaas = f'org.apache.kafka.common.security.plain.PlainLoginModule required username="broker" password="{password}" user_broker="{password}" user_admin="{password}" user_app="{password}" user_outsider="{password}";'
            env.update(KAFKA_LISTENER_NAME_INTERNAL_PLAIN_SASL_JAAS_CONFIG=jaas, KAFKA_LISTENER_NAME_CONTROLLER_PLAIN_SASL_JAAS_CONFIG=jaas)
            options = ['--memory','1536m','--network-alias','kafka','--mount',f'type=bind,src={fixture},dst=/fixture,readonly']
            for key, value in env.items():
                options += ['-e', f'{key}={value}']
            start(kafka, args.kafka_image, options)
            topics = ['/opt/kafka/bin/kafka-topics.sh','--bootstrap-server','kafka:29092','--command-config','/fixture/admin.properties']
            wait_for(kafka, topics+['--list'])
            check('Kafka authenticated TLS KRaft ready', True)
            topic = 'gg-vendor-tenant-a-events'
            exec_in(kafka, topics+['--create','--topic','gg-vendor-tenant-b-events','--partitions','1','--replication-factor','1'])
            exec_in(kafka, topics+['--create','--topic',topic,'--partitions','1','--replication-factor','1','--config','min.insync.replicas=1'])
            acl = ['/opt/kafka/bin/kafka-acls.sh','--bootstrap-server','kafka:29092','--command-config','/fixture/admin.properties','--add','--allow-principal','User:app']
            exec_in(kafka, acl+['--operation','Read','--operation','Write','--operation','Describe','--topic',topic])
            exec_in(kafka, acl+['--operation','Read','--group','gg-vendor-tenant-a'])
            message = json.dumps({'tenantId':'isolated-tenant-a','eventId':args.run_id,'type':'outbox.cdc.fixture'})
            produced = exec_in(kafka, ['/opt/kafka/bin/kafka-console-producer.sh','--bootstrap-server','kafka:29092','--producer.config','/fixture/app.properties','--topic',topic], input=message+'\n')
            check('Kafka scoped producer accepted', produced.returncode == 0 and 'ERROR' not in produced.stderr, produced.stderr[-500:])
            consumed = exec_in(kafka, ['/opt/kafka/bin/kafka-console-consumer.sh','--bootstrap-server','kafka:29092','--consumer.config','/fixture/app.properties','--topic',topic,'--group','gg-vendor-tenant-a','--from-beginning','--max-messages','1','--timeout-ms','15000'])
            check('Kafka scoped consumer payload roundtrip', message in consumed.stdout, (consumed.stdout+consumed.stderr)[-800:])
            denied = exec_in(kafka, ['/opt/kafka/bin/kafka-console-consumer.sh','--bootstrap-server','kafka:29092','--consumer.config','/fixture/outsider.properties','--topic',topic,'--group','gg-vendor-denied','--max-messages','1','--timeout-ms','10000'], ok=False)
            check('Kafka unauthorized principal denied by ACL', 'Authorization' in denied.stderr and message not in denied.stdout, denied.stderr[-500:])
            denied = exec_in(kafka, ['/opt/kafka/bin/kafka-topics.sh','--bootstrap-server','kafka:29092','--command-config','/fixture/bad.properties','--list'], ok=False)
            check('Kafka bad password rejected', denied.returncode != 0 and 'Authentication' in denied.stderr, denied.stderr[-500:])
            denied = exec_in(kafka, ['/opt/kafka/bin/kafka-console-producer.sh','--bootstrap-server','kafka:29092','--producer.config','/fixture/app.properties','--topic','gg-vendor-tenant-b-events'], input=message+'\n', ok=False)
            # Console producer may exit 0 after asynchronous send failures. Prove the
            # authorized admin sees no accepted record, rather than trusting that code.
            offsets = exec_in(kafka, ['/opt/kafka/bin/kafka-get-offsets.sh','--bootstrap-server','kafka:29092','--command-config','/fixture/admin.properties','--topic','gg-vendor-tenant-b-events'])
            check('Kafka tenant B topic denied with zero accepted records', 'Authorization' in denied.stderr and offsets.stdout.strip() == 'gg-vendor-tenant-b-events:0:0', (denied.stderr+offsets.stdout)[-500:])
            # CLI trusts only this generated CA, with endpoint validation explicitly enabled.
            logs = run(['docker','logs',kafka],ok=False)
            (output/'kafka.log').write_text((logs.stdout+logs.stderr).replace(password,'<fixture-password>'))
            if not resources.remove_one('container',kafka):
                raise RuntimeError('Kafka cleanup failed; see cleanup inventory')

        if args.service in ('all','cassandra'):
            cassandra = network+'-cassandra'
            # Use the repository's actual chart configuration generator, extracted without Helm templating.
            chart = Path(__file__).resolve().parents[2]/'infra/gitops/disposable/cassandra-chart/templates/bootstrap-scripts.yaml'
            text = chart.read_text().split('  configure.py: |\n',1)[1].split('  check-tls.py:',1)[0]
            script = '\n'.join(line[4:] for line in text.splitlines())+'\n'
            script = script.replace("'/generated-config'", "'/etc/cassandra'")
            script = script.replace('shutil.copytree(source, target, dirs_exist_ok=True)', 'pass  # config already lives in writable candidate layer')
            (fixture/'configure-cassandra.py').write_text(script)
            command = 'python3 /fixture/configure-cassandra.py && exec /usr/local/bin/docker-entrypoint.sh cassandra -f'
            data_volume = network+'-cassandra-data'
            resources.reserve('volume',data_volume)
            run(['docker','volume','create','--label',resources.label_argument,data_volume])
            cassandra_options = ['--memory','2g','--network-alias','cassandra','--user','999:999',
                 '--mount',f'type=bind,src={fixture},dst=/fixture,readonly', '--mount',f'type=bind,src={fixture},dst=/cql-tls,readonly',
                 '--mount',f'type=volume,src={data_volume},dst=/var/lib/cassandra',
                 '-e','MAX_HEAP_SIZE=512M','-e','HEAP_NEWSIZE=128M','-e','CASSANDRA_NUM_TOKENS=16',
                 '-e','JVM_EXTRA_OPTS=-XX:ActiveProcessorCount=1 -XX:MaxDirectMemorySize=256M',
                 '-e','CASSANDRA_KEYSTORE_PASSWORD='+password, '--entrypoint','sh']
            start(cassandra,args.baseline_cassandra_image,cassandra_options,['-c',command])
            def cql(user, secret, statement, ok=True):
                return exec_in(cassandra,['env','SSL_CERTFILE=/fixture/ca.crt','SSL_VALIDATE=true',
                    'cqlsh','--ssl','--connect-timeout','10','--request-timeout','15','-u',user,'-p',secret,'cassandra','9042','-e',statement],ok=ok,timeout=45)
            tls = ['python3','-c', "import socket,ssl; c=ssl.create_default_context(cafile='/fixture/ca.crt'); c.wrap_socket(socket.create_connection(('cassandra',9042),timeout=4),server_hostname='cassandra').close()"]
            wait_for(cassandra,tls,attempts=60)
            baseline_query = wait_for(cassandra,['env','SSL_CERTFILE=/fixture/ca.crt','SSL_VALIDATE=true','cqlsh','--ssl','-u','cassandra','-p','cassandra','cassandra','9042','-e','SELECT release_version FROM system.local'],attempts=25)
            (output/'baseline-version-query.json').write_text(json.dumps({'expected':'5.0.5','query':'SELECT release_version FROM system.local','exitCode':baseline_query.returncode,'stdout':baseline_query.stdout,'stderr':baseline_query.stderr},indent=2)+'\n')
            versions['baseline'] = release_version(baseline_query,'5.0.5')
            (output/'versions.json').write_text(json.dumps(versions,indent=2)+'\n')
            check('Cassandra runtime baseline exactly 5.0.5', versions['baseline'] == '5.0.5', baseline_query.stdout)
            cql('cassandra','cassandra',f"ALTER ROLE cassandra WITH PASSWORD = '{password}'")
            wait_for(cassandra,['env','SSL_CERTFILE=/fixture/ca.crt','SSL_VALIDATE=true','cqlsh','--ssl','-u','cassandra','-p',password,'cassandra','9042','-e','SELECT release_version FROM system.local'],attempts=20)
            cql('cassandra',password,"CREATE KEYSPACE gg_vendor WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}")
            cql('cassandra',password,'CREATE TABLE gg_vendor.events (tenant text, event text, value text, PRIMARY KEY (tenant, event))')
            cql('cassandra',password,f"CREATE ROLE fixture_writer WITH LOGIN = true AND PASSWORD = '{password}'")
            cql('cassandra',password,f"CREATE ROLE fixture_denied WITH LOGIN = true AND PASSWORD = '{password}'")
            cql('cassandra',password,'GRANT SELECT ON TABLE gg_vendor.events TO fixture_writer; GRANT MODIFY ON TABLE gg_vendor.events TO fixture_writer')
            cql('fixture_writer',password,f"INSERT INTO gg_vendor.events (tenant, event, value) VALUES ('tenant-a', '{args.run_id}', 'before-upgrade')")
            check('Cassandra baseline scoped writer payload seeded', 'before-upgrade' in cql('fixture_writer',password,"SELECT value FROM gg_vendor.events WHERE tenant = 'tenant-a'").stdout)
            exec_in(cassandra,['nodetool','flush'],timeout=60)
            exec_in(cassandra,['nodetool','drain'],timeout=60)
            logs = run(['docker','logs',cassandra],ok=False)
            (output/'cassandra-baseline.log').write_text((logs.stdout+logs.stderr).replace(password,'<fixture-password>'))
            if not resources.remove_one('container',cassandra):
                raise RuntimeError('baseline Cassandra cleanup failed; see cleanup inventory')
            # Only this test's new volume is reused across these two sequential processes.
            start(cassandra,args.cassandra_image,cassandra_options,['-c',command])
            wait_for(cassandra,tls,attempts=60)
            candidate_query = wait_for(cassandra,['env','SSL_CERTFILE=/fixture/ca.crt','SSL_VALIDATE=true','cqlsh','--ssl','-u','cassandra','-p',password,'cassandra','9042','-e','SELECT release_version FROM system.local'],attempts=20)
            (output/'candidate-version-query.json').write_text(json.dumps({'expected':'5.0.9','query':'SELECT release_version FROM system.local','exitCode':candidate_query.returncode,'stdout':candidate_query.stdout,'stderr':candidate_query.stderr},indent=2)+'\n')
            versions['candidate'] = release_version(candidate_query,'5.0.9')
            (output/'versions.json').write_text(json.dumps(versions,indent=2)+'\n')
            check('Cassandra runtime candidate exactly 5.0.9', versions['candidate'] == '5.0.9', candidate_query.stdout)
            version = wait_for(cassandra,['env','SSL_CERTFILE=/fixture/ca.crt','SSL_VALIDATE=true','cqlsh','--ssl','-u','fixture_writer','-p',password,'cassandra','9042','-e',"SELECT value FROM gg_vendor.events WHERE tenant = 'tenant-a'"],attempts=20)
            check('Cassandra 5.0.5 to 5.0.9 persisted SSTable payload readable', 'before-upgrade' in version.stdout)
            cql('fixture_writer',password,f"INSERT INTO gg_vendor.events (tenant, event, value) VALUES ('tenant-a', '{args.run_id}', 'after-upgrade')")
            check('Cassandra candidate scoped writer roundtrip', 'after-upgrade' in cql('fixture_writer',password,"SELECT value FROM gg_vendor.events WHERE tenant = 'tenant-a'").stdout)
            denied = cql('fixture_denied',password,'SELECT * FROM gg_vendor.events',ok=False)
            check('Cassandra ungranted role denied', 'Unauthorized' in denied.stdout+denied.stderr, (denied.stdout+denied.stderr)[-500:])
            denied = cql('fixture_writer','incorrect-test-password','SELECT * FROM gg_vendor.events',ok=False)
            check('Cassandra bad password rejected', 'Authentication' in denied.stdout+denied.stderr, (denied.stdout+denied.stderr)[-500:])
            denied = exec_in(cassandra,['python3','-c',"import socket,ssl; c=ssl.create_default_context(); c.wrap_socket(socket.create_connection(('cassandra',9042),timeout=4),server_hostname='cassandra')"],ok=False)
            check('Cassandra untrusted CA rejected', denied.returncode != 0 and 'CERTIFICATE_VERIFY_FAILED' in denied.stderr)
            denied = exec_in(cassandra,['cqlsh','-u','fixture_writer','-p',password,'cassandra','9042','-e','SELECT * FROM gg_vendor.events'],ok=False,timeout=20)
            check('Cassandra plaintext CQL rejected', denied.returncode != 0 and 'after-upgrade' not in denied.stdout)
            check('Cassandra default admin password no longer works', 'Authentication' in (lambda r: r.stdout+r.stderr)(cql('cassandra','cassandra','SELECT release_version FROM system.local',ok=False)))
            cql('fixture_writer',password,"INSERT INTO gg_vendor.events (tenant,event,value) VALUES ('tenant-a','ttl','expires') USING TTL 3")
            time.sleep(4)
            check('Cassandra TTL expires rows', 'expires' not in cql('fixture_writer',password,"SELECT value FROM gg_vendor.events WHERE tenant='tenant-a' AND event='ttl'").stdout)
        check('SINGLE_NODE_TLS_SMOKE_PASS (not full deployment or CDC proof)', True)
    finally:
        # Logs, every owned Docker resource, keys, and evidence writes each get
        # their own attempt. A timeout in one never skips the others.
        def collect_logs(container):
            obj = resources.inspect('container',container)
            if obj is not None:
                labels = obj.get('Config',{}).get('Labels')
                if not isinstance(labels,dict) or labels.get(resources.label) != resources.owner:
                    raise RuntimeError('log ownership differs; refusing access')
                logs = run(['docker','logs',container],ok=False,timeout=15)
                if logs.returncode:
                    raise RuntimeError('log collection failed: '+logs.stderr[-400:])
                (output/(container+'.log')).write_text((logs.stdout+logs.stderr).replace(password,'<fixture-password>'))
        cleanup = resources.cleanup(collect_logs)
        try:
            shutil.rmtree(fixture)
            cleanup['fixturesAbsentVerified'] = not fixture.exists()
        except Exception as error:
            cleanup['fixturesAbsentVerified'] = False
            cleanup['fixtureError'] = str(error)
        cleanup['cleanupComplete'] = cleanup['cleanupComplete'] and cleanup['fixturesAbsentVerified']
        (output/'cleanup.json').write_text(json.dumps(cleanup,indent=2)+'\n')
        (output/'checks.json').write_text(json.dumps(checks,indent=2)+'\n')
        if not cleanup['cleanupComplete']:
            raise RuntimeError('owned cleanup/evidence failed; see cleanup.json')


if __name__ == '__main__':
    main()
