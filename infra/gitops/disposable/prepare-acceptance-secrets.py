#!/usr/bin/env python3
"""Enrich a protected operator bundle; no AWS calls or secret output."""
import argparse
import copy
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys

MODULE = 'org.apache.kafka.common.security.plain.PlainLoginModule'
OPTION = re.compile(r'([A-Za-z][A-Za-z0-9_-]*)="([A-Za-z0-9_.:/@+=-]+)"')
CLIENT = re.compile(re.escape(MODULE) + r' required username="acceptance-probe" password="([A-Za-z0-9_-]{32,128})";')


def parse_broker(value):
    if not isinstance(value, str) or not value.startswith(MODULE + ' required ') or not value.endswith(';'):
        raise ValueError('broker JAAS must be one exact PLAIN stanza')
    options = value[len(MODULE + ' required '):-1]
    parsed = {}
    position = 0
    while position < len(options):
        match = OPTION.match(options, position)
        if not match or match[1] in parsed:
            raise ValueError('broker JAAS has unsupported or duplicate options')
        parsed[match[1]] = match[2]
        position = match.end()
        if position < len(options):
            if not options[position].isspace():
                raise ValueError('broker JAAS options must be separated')
            while position < len(options) and options[position].isspace():
                position += 1
    if (parsed.get('username') != 'broker' or not parsed.get('password') or
            parsed.get('user_broker') != parsed['password'] or
            any(key not in {'username', 'password'} and not re.fullmatch(r'user_[A-Za-z0-9_-]+', key) for key in parsed)):
        raise ValueError('broker JAAS must preserve its matching broker identity and only named users')
    return parsed


def enrich(bundle, scope):
    if not isinstance(scope, dict) or set(scope) != {'account_id', 'region', 'environment', 'cluster_name'}:
        raise ValueError('scope requires exactly account_id, region, environment, cluster_name')
    environment = scope['environment']
    if (not isinstance(environment, str) or not re.fullmatch(r'[a-z][a-z0-9-]{1,15}', environment) or
            environment in {'prod', 'production'} or not re.fullmatch(r'[0-9]{12}', str(scope['account_id'])) or
            not re.fullmatch(r'[a-z]{2}(?:-[a-z]+)+-[0-9]', str(scope['region'])) or
            not re.fullmatch(r'greenguard-' + re.escape(environment) + r'-[a-z0-9-]+', str(scope['cluster_name']))):
        raise ValueError('scope must identify a non-production disposable account and cell')
    if not isinstance(bundle, dict) or not isinstance(bundle.get('runtime_secret_values'), dict):
        raise ValueError('bundle must contain runtime_secret_values')
    for key, value in [('target_account_id', scope['account_id']), ('environment', environment), ('cluster_name', scope['cluster_name'])]:
        if key in bundle and bundle[key] != value:
            raise ValueError('bundle scope differs from explicit disposable cell scope')
    result = copy.deepcopy(bundle)
    runtime = result['runtime_secret_values']
    kafka = runtime.get('greenguard-kafka-auth')
    search = runtime.get('greenguard-opensearch-clients')
    if not isinstance(kafka, dict) or not isinstance(search, dict):
        raise ValueError('bundle must supply the owned Kafka and OpenSearch credentials')
    parsed = parse_broker(kafka.get('broker-jaas'))
    changes = []
    client = kafka.get('acceptance-client-jaas')
    broker_password = parsed.get('user_acceptance-probe')
    if client is not None or broker_password is not None:
        match = CLIENT.fullmatch(client or '')
        if not match or match[1] != broker_password or broker_password in {v for k, v in parsed.items() if k != 'user_acceptance-probe'}:
            raise ValueError('existing acceptance JAAS is partial, mismatched or shares the broker password')
    else:
        password = secrets.token_urlsafe(36)
        parsed['user_acceptance-probe'] = password
        kafka['broker-jaas'] = MODULE + ' required ' + ' '.join(f'{key}="{value}"' for key, value in parsed.items()) + ';'
        kafka['acceptance-client-jaas'] = MODULE + f' required username="acceptance-probe" password="{password}";'
        changes.append('greenguard-kafka-auth')
    old_keys = {'writer-password', 'reader-password'}
    all_keys = old_keys | {'acceptance-writer-password', 'acceptance-reader-password'}
    if set(search) == old_keys:
        if not all(isinstance(value, str) and value for value in search.values()) or len(set(search.values())) != 2:
            raise ValueError('OpenSearch runtime passwords must be present and distinct')
        search.update({key: secrets.token_urlsafe(36) for key in all_keys - old_keys})
        changes.append('greenguard-opensearch-clients')
    elif set(search) != all_keys:
        raise ValueError('OpenSearch keys must be exactly the runtime pair or the complete acceptance profile')
    if not all(isinstance(value, str) and value for value in search.values()) or len(set(search.values())) != 4:
        raise ValueError('OpenSearch passwords must be present and distinct')
    counters = result.setdefault('secret_version_counters', {})
    if not isinstance(counters, dict):
        raise ValueError('version counters must be a map')
    for name in changes:
        key = 'runtime/' + name
        current = counters.get(key, 1)
        if not isinstance(current, int) or isinstance(current, bool) or current < 1:
            raise ValueError('runtime version counters must be positive integers')
        counters[key] = current + 1
    return result


def protected_read(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid():
            raise ValueError('operator bundle must be an owned regular file with mode 0600')
        return json.load(stream)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--scope-file', required=True, type=Path, help='public Terraform cell.json')
    args = parser.parse_args(argv)
    result = enrich(protected_read(args.input), json.loads(args.scope_file.read_text()))
    # O_EXCL refuses existing output; O_NOFOLLOW refuses symlinks. No in-place overwrite.
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(result, stream, separators=(',', ':'))
            stream.write('\n')
    except BaseException:
        args.output.unlink(missing_ok=True)
        raise
    print('Prepared protected acceptance bundle; no values shown')
    return 0

if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, TypeError) as error:
        # Parser and file errors can include secret text; return a fixed diagnostic.
        print('FAIL acceptance bundle: invalid scope, protected file, credential profile or output path', file=sys.stderr)
        raise SystemExit(1)
