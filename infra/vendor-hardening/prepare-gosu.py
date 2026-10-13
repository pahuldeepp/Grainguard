#!/usr/bin/env python3
"""Prepare a locked, offline gosu source build without modifying upstream code."""
import hashlib
import importlib.util
import json
import os
import secrets
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path
# Load this repository's import-safe helper by absolute path, including under -P.
helper_spec = importlib.util.spec_from_file_location('vendor_smoke',Path(__file__).with_name('smoke.py'))
helper = importlib.util.module_from_spec(helper_spec)
helper_spec.loader.exec_module(helper)
OwnedResources = helper.OwnedResources

here = Path(__file__).resolve().parent
context = Path(sys.argv[1]).resolve()
context.mkdir(parents=True)
lock = json.loads((here/'gosu-source-lock.json').read_text())

def fetch(entry, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    with urllib.request.urlopen(entry['url'], timeout=60) as response, target.open('wb') as out:
        while chunk := response.read(1024*1024):
            digest.update(chunk)
            out.write(chunk)
    if digest.hexdigest() != entry['sha256']:
        raise SystemExit(f'{target.name}: checksum mismatch')

for name in ('go','gosu'):
    fetch(lock[name], context/(name+'.tar.gz'))
for module in lock['modules']:
    relative = Path(module['relative'])
    if relative.is_absolute() or '..' in relative.parts:
        raise SystemExit('invalid locked module path')
    fetch(module, context/'module-proxy'/relative)

# The unchanged upstream go.sum authenticates module content. All module zips and
# metadata are downloaded with HTTPS validation and checksum locks before this
# bounded network-disabled process; Go's normal checksum verification stays on.
command = '''set -eu
trap 'chown -R "$GG_VENDOR_HOST_UID:$GG_VENDOR_HOST_GID" /workspace; find /workspace -type d -exec chmod u+w {} +' EXIT
cd /workspace
tar -xzf go.tar.gz
mkdir source
tar -xzf gosu.tar.gz -C source --strip-components=1
cd source
export PATH=/workspace/go/bin:$PATH GOTOOLCHAIN=local GOMAXPROCS=1 GOMEMLIMIT=512MiB
export GOMODCACHE=/workspace/modcache GOCACHE=/workspace/gocache GOPROXY=file:///workspace/module-proxy
go mod download
go mod verify
go mod vendor
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - vendor | gzip -n > /workspace/vendor.tar.gz
go test -mod=vendor ./...
'''
base = json.loads((here/'candidates.json').read_text())['candidates']['cassandra']['source']
container = 'gg-vendor-source-'+secrets.token_hex(8)
resources = OwnedResources()
try:
    resources.reserve('container',container)
    subprocess.run(['docker','run','--rm','--pull','never','--label',resources.label_argument,'--name',container,
                '--network','none','--cpus','1','--memory','768m','--pids-limit','128','--user','0',
                '-e',f'GG_VENDOR_HOST_UID={os.getuid()}','-e',f'GG_VENDOR_HOST_GID={os.getgid()}',
                '--mount',f'type=bind,src={context},dst=/workspace','--entrypoint','sh',base,'-c',command], check=True, timeout=600)
finally:
    cleanup = resources.cleanup()
    (context/'source-cleanup.json').write_text(json.dumps(cleanup,indent=2)+'\n')
    if not cleanup['cleanupComplete']:
        raise RuntimeError('source preparation cleanup failed; see source-cleanup.json')
vendor = context/'vendor.tar.gz'
if hashlib.sha256(vendor.read_bytes()).hexdigest() != lock['vendorArchiveSha256']:
    raise SystemExit('vendored module archive mismatch')
(context/'SHA256SUMS').write_text(''.join(
    f"{lock[name]['sha256']}  {name}.tar.gz\n" for name in ('go','gosu')) +
    f"{lock['vendorArchiveSha256']}  vendor.tar.gz\n")
shutil.copyfile(here/'Dockerfile.cassandra',context/'Dockerfile.cassandra')
(context/'.dockerignore').write_text('*\n!Dockerfile.cassandra\n!go.tar.gz\n!gosu.tar.gz\n!vendor.tar.gz\n!SHA256SUMS\n')

# Keep only the small immutable build inputs, after all verification has passed.
for generated in ('go','source','modcache','gocache','module-proxy'):
    target = context/generated
    # Go module cache directories are intentionally read-only even after chown.
    for directory, _, _ in os.walk(target):
        path = Path(directory)
        path.chmod(path.stat().st_mode | 0o700)
    shutil.rmtree(target)
