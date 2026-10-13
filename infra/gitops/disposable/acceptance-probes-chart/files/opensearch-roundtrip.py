"""Verified native HTTPS, fixture-only users and unique tenant documents."""
import base64
import json
import os
import ssl
import time
import uuid
import urllib.error
import urllib.request

BASE = 'https://greenguard-opensearch.greenguard.svc.cluster.local:9200'
INDEX = 'greenguard-acceptance-probe-v1'
AUTH = '/search-auth'
CONTEXT = ssl.create_default_context(cafile='/search-ca/ca.crt')

def request(method, path, payload=None, role='writer', expected=(200, 201)):
    headers = {'Content-Type': 'application/json'}
    if role is not None:
        password = open(f'{AUTH}/acceptance-{role}-password').read().strip()
        if not password:
            raise RuntimeError('missing fixture credential')
        credentials = f'greenguard_acceptance_{role}:{password}'.encode()
        headers['Authorization'] = 'Basic ' + base64.b64encode(credentials).decode()
    body = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(BASE + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, context=CONTEXT, timeout=10) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
    if status not in expected:
        # Do not echo server response, credentials or domain records.
        raise RuntimeError(f'{method} fixture operation returned HTTP {status}')
    result = json.loads(raw) if raw else {}
    if path.endswith('/_search') and status == 200:
        if result.get('timed_out') is not False or result.get('_shards', {}).get('failed') != 0:
            raise RuntimeError('fixture search timed out or returned partial shard failures')
    return result

def main():
    for attempt in range(int(os.environ.get('PROBE_READY_ATTEMPTS', '36'))):
        try:
            request('POST', f'/{INDEX}/_search', {'size': 0}, role='reader')
            break
        except (RuntimeError, OSError):
            if attempt == int(os.environ.get('PROBE_READY_ATTEMPTS', '36')) - 1:
                raise RuntimeError('fixture index/auth/TLS unavailable before deadline') from None
            time.sleep(5)
    request('POST', f'/{INDEX}/_search', {'size': 0}, role=None, expected=(401,))
    run = str(uuid.uuid4())
    tenant_a, tenant_b = str(uuid.uuid4()), str(uuid.uuid4())
    created = []
    try:
        for suffix, tenant, marker in [('a', tenant_a, run), ('b', tenant_b, 'other-' + run)]:
            doc = run + '-' + suffix
            # Register before the write: cleanup also handles ambiguous network outcomes.
            created.append(doc)
            request('PUT', f'/{INDEX}/_doc/{doc}?refresh=wait_for', {'tenant_id': tenant, 'marker': marker})
        result = request('POST', f'/{INDEX}/_search', {
            'query': {'bool': {'filter': [{'term': {'tenant_id': tenant_a}}, {'term': {'marker': run}}]}}
        }, role='reader')
        hits = result['hits']['hits']
        if len(hits) != 1 or hits[0]['_source'] != {'tenant_id': tenant_a, 'marker': run}:
            raise RuntimeError('tenant-filtered search did not return exact written fixture')
        other = request('POST', f'/{INDEX}/_search', {
            'query': {'bool': {'filter': [{'term': {'tenant_id': tenant_b}}, {'term': {'marker': run}}]}}
        }, role='reader')
        if other['hits']['hits']:
            raise RuntimeError('tenant filter returned another tenant fixture')
        request('PUT', f'/{INDEX}/_doc/{run}-denied', {'tenant_id': tenant_a, 'marker': 'denied'}, role='reader', expected=(403,))
        request('PUT', f'/greenguard-acceptance-denied-v1/_doc/{run}', {'marker': 'denied'}, expected=(403,))
    finally:
        for doc in created:
            request('DELETE', f'/{INDEX}/_doc/{doc}?refresh=wait_for', expected=(200, 404))
    for doc in created:
        request('GET', f'/{INDEX}/_doc/{doc}', role='reader', expected=(404,))
    print('PASS opensearch-index-search: HTTPS/AUTH, scoped index, tenant filter, reader denial and cleanup verified')

if __name__ == '__main__':
    main()
