"""Run the existing PostgreSQL/HTTP acceptance through a disposable real Kafka broker."""
from __future__ import annotations
import os
import socket
import subprocess
import time
from uuid import uuid4
from confluent_kafka import Producer, Consumer
from confluent_kafka.admin import AdminClient, NewTopic
import postgres_acceptance
from knowledge_extensions.kafka_runtime import TOPIC, decode_event, publish_pending_once

IMAGE = 'apache/kafka@sha256:4ceccc577f03f51f6af8dbfda55194d0d892f4fa7913ffbded567ce3895622ed'

def main():
    name = 'gg-knowledge-kafka-' + uuid4().hex[:10]
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    broker = f'127.0.0.1:{port}'
    args = ['docker','run','--rm','-d','--name',name,'-p',f'127.0.0.1:{port}:9092']
    config = {'CLUSTER_ID':'MkU3OEVBNTcwNTJENDM2Qk','KAFKA_NODE_ID':'1',
              'KAFKA_PROCESS_ROLES':'broker,controller','KAFKA_CONTROLLER_QUORUM_VOTERS':'1@localhost:9093',
              'KAFKA_LISTENERS':'PLAINTEXT://:9092,CONTROLLER://:9093',
              'KAFKA_ADVERTISED_LISTENERS':f'PLAINTEXT://{broker}',
              'KAFKA_CONTROLLER_LISTENER_NAMES':'CONTROLLER',
              'KAFKA_LISTENER_SECURITY_PROTOCOL_MAP':'PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT',
              'KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR':'1','KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS':'0'}
    for key,value in config.items():
        args += ['-e',f'{key}={value}']
    subprocess.run(args+[IMAGE],check=True,capture_output=True)
    try:
        admin = AdminClient({'bootstrap.servers':broker})
        for attempt in range(60):
            try:
                admin.list_topics(timeout=1)
                break
            except Exception:
                time.sleep(1)
        else:
            raise RuntimeError('Kafka did not become ready')
        for future in admin.create_topics([NewTopic(TOPIC,1,1)]).values():
            future.result(10)
        os.environ['KNOWLEDGE_ACCEPTANCE_KAFKA'] = broker
        postgres_acceptance.main()
    finally:
        os.environ.pop('KNOWLEDGE_ACCEPTANCE_KAFKA',None)
        subprocess.run(['docker','rm','-f',name],capture_output=True)

if __name__ == '__main__':
    main()
