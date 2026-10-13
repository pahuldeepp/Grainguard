#!/usr/bin/env python3
"""Fetch exact, checksum-locked APKs. APK signature checks remain enabled in build."""
import hashlib
import json
import shutil
import sys
import urllib.request
from pathlib import Path

here = Path(__file__).resolve().parent
context = Path(sys.argv[1])
context.mkdir(parents=True, exist_ok=True)
apks = context / 'apks'
apks.mkdir()
shutil.copyfile(here / 'Dockerfile.kafka', context / 'Dockerfile.kafka')
lock = json.loads((here / 'kafka-apk-lock.json').read_text())
sums = []
for package in lock['packages']:
    filename = package['filename']
    if Path(filename).name != filename or not package['url'].startswith(
            'https://dl-cdn.alpinelinux.org/alpine/v3.23/') or not package['url'].endswith('/aarch64/' + filename):
        raise SystemExit('invalid locked package source')
    target = apks / filename
    digest = hashlib.sha256()
    with urllib.request.urlopen(package['url'], timeout=60) as response, target.open('wb') as output:
        while chunk := response.read(1024 * 1024):
            digest.update(chunk)
            output.write(chunk)
    if digest.hexdigest() != package['sha256']:
        raise SystemExit(f'{filename}: checksum mismatch; refusing build')
    sums.append(f"{package['sha256']}  {filename}\n")
(apks / 'SHA256SUMS').write_text(''.join(sums))
