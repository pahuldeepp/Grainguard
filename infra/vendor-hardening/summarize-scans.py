#!/usr/bin/env python3
"""Validate complete image/service evidence before evaluating the unchanged policy."""
import argparse
import json
import re
from collections import Counter
from datetime import datetime
from pathlib import Path

DIGEST = re.compile(r'^sha256:[a-f0-9]{64}$')
SERVICES = {'kafka': ('org.apache.kafka:kafka-clients', '3.9.2'),
            'cassandra': ('org.apache.cassandra:cassandra-all', '5.0.9')}


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def validate_report(report, inspection, service):
    def require(condition, message):
        if not condition:
            raise ValueError(message)
    require(service in SERVICES, 'unsupported service')
    require(isinstance(report, dict) and report.get('SchemaVersion') == 2,
            'missing supported Trivy schema')
    require(isinstance(inspection, list) and len(inspection) == 1 and isinstance(inspection[0], dict),
            'missing single image inspection')
    image = inspection[0]
    require(nonempty(image.get('Id')) and DIGEST.fullmatch(image['Id']), 'invalid inspected image digest')
    require(report.get('ArtifactType') == 'container_image', 'not an image scan')
    metadata = report.get('Metadata')
    require(isinstance(metadata, dict), 'missing image metadata')
    require(metadata.get('ImageID') == image['Id'], 'scan does not match inspected image digest')
    references = [image['Id']]
    for field in ('RepoTags','RepoDigests'):
        values = image.get(field)
        if values is None:
            values = []
        require(isinstance(values,list) and all(nonempty(x) for x in values), 'malformed image references')
        references.extend(values)
    require(nonempty(report.get('ArtifactName')) and report['ArtifactName'] in references,
            'scan artifact does not match inspected image reference')
    require(nonempty(report.get('CreatedAt')), 'missing scan timestamp')
    try:
        require(datetime.fromisoformat(report['CreatedAt'].replace('Z', '+00:00')).tzinfo is not None,
                'scan timestamp lacks timezone')
    except (ValueError, TypeError):
        raise ValueError('invalid scan timestamp') from None
    os_metadata = metadata.get('OS')
    require(isinstance(os_metadata, dict) and all(nonempty(os_metadata.get(x)) for x in ('Family', 'Name')),
            'missing OS inventory metadata')
    results = report.get('Results')
    require(isinstance(results, list) and bool(results), 'missing result inventory')
    inventories = set()
    packages = []
    findings = []
    seen = set()
    for result in results:
        require(isinstance(result, dict), 'result is not an object')
        target, kind, package_type = (result.get(x) for x in ('Target', 'Class', 'Type'))
        require(nonempty(target) and kind in ('os-pkgs', 'lang-pkgs') and nonempty(package_type),
                'invalid result target/class/type')
        require((kind == 'os-pkgs' and package_type == os_metadata['Family']) or
                (kind == 'lang-pkgs' and package_type in ('jar', 'gobinary')), 'unexpected package inventory type')
        require((target, kind, package_type) not in seen, 'duplicate result inventory')
        seen.add((target, kind, package_type))
        inventories.add((kind, package_type))
        inventory = result.get('Packages')
        require(isinstance(inventory, list) and bool(inventory), 'missing analyzed package inventory')
        for package in inventory:
            require(isinstance(package, dict) and nonempty(package.get('Name')), 'malformed analyzed package')
            unversioned_gosu_root = (package_type == 'gobinary' and package['Name'] == 'github.com/tianon/gosu'
                and package.get('Relationship') == 'root' and package.get('AnalyzedBy') == 'gobinary'
                and isinstance(package.get('DependsOn'), list) and 'stdlib@v1.27.2' in package['DependsOn'])
            require(nonempty(package.get('Version')) or unversioned_gosu_root, 'missing analyzed package version')
            packages.append(package)
        vulnerabilities = result.get('Vulnerabilities')
        # Trivy legitimately omits/nulls clean results. Only a fully validated
        # analyzed package inventory above can support that absence.
        require(vulnerabilities is None or isinstance(vulnerabilities, list), 'malformed vulnerability collection')
        for item in vulnerabilities or []:
            require(isinstance(item, dict) and all(nonempty(item.get(x)) for x in
                    ('VulnerabilityID', 'PkgName', 'InstalledVersion', 'Severity')), 'malformed vulnerability')
            require(item['Severity'] in ('UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'), 'invalid severity')
            require('FixedVersion' not in item or isinstance(item['FixedVersion'], str), 'malformed fixed version')
            require(any(p['Name'] == item['PkgName'] and p.get('Version') == item['InstalledVersion'] for p in inventory),
                    'vulnerability is absent from analyzed package inventory')
            if item.get('FixedVersion') and item['Severity'] in ('HIGH', 'CRITICAL'):
                findings.append({'target': target, 'class': kind, 'id': item['VulnerabilityID'],
                                 'package': item['PkgName'], 'installed': item['InstalledVersion'],
                                 'fixed': item['FixedVersion'], 'severity': item['Severity']})
    require(('os-pkgs', os_metadata['Family']) in inventories and ('lang-pkgs', 'jar') in inventories,
            'service image lacks OS or Java analysis')
    package_name, version = SERVICES[service]
    require(any(p['Name'] == package_name and p.get('Version') == version for p in packages),
            'wrong service image or service version')
    if service == 'cassandra':
        require(any(r['Target'] == 'usr/local/bin/gosu' and r['Type'] == 'gobinary' for r in results)
                and any(p['Name'] == 'stdlib' and p.get('Version') == 'v1.27.2' for p in packages),
                'Cassandra image lacks the locked gosu/Go analysis')
    return {'artifact': report['ArtifactName'], 'service': service, 'imageDigest': image['Id'],
            'createdAt': report['CreatedAt'], 'metadata': metadata, 'evidenceValid': True,
            'policyPass': not findings, 'counts': dict(Counter(x['severity'] for x in findings)),
            'findings': findings}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('reports', nargs='+')
    parser.add_argument('--inspection', action='append', required=True)
    parser.add_argument('--service', action='append', choices=SERVICES, required=True)
    args = parser.parse_args()
    if len(args.reports) != len(args.inspection) or len(args.reports) != len(args.service):
        parser.error('each report requires its own image inspection and expected service')
    output = []
    for report, inspection, service in zip(args.reports, args.inspection, args.service):
        try:
            output.append(validate_report(json.loads(Path(report).read_text()),
                                          json.loads(Path(inspection).read_text()), service))
        except (ValueError, KeyError, TypeError) as error:
            raise SystemExit(f'{report}: invalid scan evidence: {error}') from None
    print(json.dumps(output, indent=2))


if __name__ == '__main__':
    main()
