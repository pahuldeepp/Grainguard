#!/usr/bin/env python3
import json
import copy
import importlib.util
import os
import shlex
import sys
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
from smoke import OwnedResources, release_version
spec = importlib.util.spec_from_file_location('scan_evidence',HERE/'summarize-scans.py')
scan_evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan_evidence)


class StrictEvidenceTest(unittest.TestCase):
    def summarize(self, report, image=None, service='kafka'):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'scan.json'
            path.write_text(json.dumps(report))
            inspection=Path(folder)/'inspect.json'
            inspection.write_text(json.dumps(image or self.image()))
            return subprocess.run([sys.executable,str(HERE/'summarize-scans.py'),str(path),
                                   '--inspection',str(inspection),'--service',service],capture_output=True,text=True)

    def image(self):
        return [{'Id':'sha256'+':'+('a'*64),'RepoTags':['fixture:candidate'],'RepoDigests':[]}]

    def report(self, vulnerabilities):
        return {'SchemaVersion':2,'CreatedAt':'2026-10-12T20:00:00-05:00',
                'ArtifactName':'fixture:candidate','ArtifactType':'container_image',
                'Metadata':{'ImageID':'sha256'+':'+('a'*64),'OS':{'Family':'alpine','Name':'3.23'}},
                'Results':[{'Target':'fixture','Class':'os-pkgs','Type':'alpine',
                            'Packages':[{'Name':'a','Version':'1'},{'Name':'b','Version':'1'}],
                            'Vulnerabilities':vulnerabilities},
                           {'Target':'Java','Class':'lang-pkgs','Type':'jar',
                            'Packages':[{'Name':'org.apache.kafka:kafka-clients','Version':'3.9.2'}]}]}

    def test_fixable_high_and_critical_block(self):
        result = self.summarize(self.report([
            {'VulnerabilityID':'HIGH','PkgName':'a','InstalledVersion':'1','FixedVersion':'2','Severity':'HIGH'},
            {'VulnerabilityID':'CRIT','PkgName':'b','InstalledVersion':'1','FixedVersion':'2','Severity':'CRITICAL'},
        ]))
        self.assertEqual(result.returncode,0)
        report=json.loads(result.stdout)[0]
        self.assertFalse(report['policyPass'])
        self.assertEqual(report['counts'],{'HIGH':1,'CRITICAL':1})

    def test_existing_fixable_policy(self):
        result=self.summarize(self.report([
            {'VulnerabilityID':'LOW','PkgName':'a','InstalledVersion':'1','FixedVersion':'2','Severity':'LOW'},
            {'VulnerabilityID':'UNFIXED','PkgName':'b','InstalledVersion':'1','Severity':'HIGH'},
        ]))
        self.assertTrue(json.loads(result.stdout)[0]['policyPass'])

    def test_missing_report_fields_never_look_clean(self):
        for report in ({}, {'Results':[]}, self.report([])|{'Results':[]},
                       self.report([])|{'Metadata':{}}, self.report([])|{'ArtifactType':'filesystem'}):
            with self.subTest(report=report):
                self.assertNotEqual(self.summarize(report).returncode,0)

    def test_null_vulnerabilities_require_complete_inventories(self):
        result=self.summarize(self.report(None))
        self.assertEqual(result.returncode,0)
        self.assertTrue(json.loads(result.stdout)[0]['policyPass'])

    def test_malformed_results_never_pass(self):
        mutations=[lambda r:r.update(Results=[{}]),lambda r:r['Results'][0].update(Vulnerabilities={}),
                   lambda r:r['Results'][0].update(Vulnerabilities=''),
                   lambda r:r['Results'][0].update(Vulnerabilities=[{'PkgName':'a'}]),
                   lambda r:r['Results'][0].update(Packages=[]),
                   lambda r:r['Results'][0].update(Class=''),
                   lambda r:r['Results'][1]['Packages'][0].update(Version='5.0.9'),
                   lambda r:r['Metadata'].update(ImageID='sha256:'+('b'*64)),
                   lambda r:r.update(ArtifactName='another:candidate')]
        for mutate in mutations:
            report=self.report([])
            mutate(report)
            with self.subTest(report=report):
                self.assertNotEqual(self.summarize(report).returncode,0)
        self.assertNotEqual(self.summarize(self.report([]),service='cassandra').returncode,0)

    def test_exact_runtime_versions_reject_override_and_ambiguous_output(self):
        def result(text):return subprocess.CompletedProcess([],0,text,'')
        self.assertEqual(release_version(result(' release_version\n--------------\n 5.0.5\n(1 rows)'),'5.0.5'),'5.0.5')
        for text in ['5.0.9','5.0.50','error mentions 5.0.5','5.0.5\n5.0.9']:
            with self.subTest(text=text),self.assertRaises(RuntimeError):
                release_version(result(text),'5.0.5')
        with self.assertRaises(RuntimeError):release_version(result('5.0.5'),'5.0.9')

    def test_cleanup_attempts_every_resource_after_timeout_and_records_failure(self):
        state={}
        attempted=[]
        def fake(command,**kwargs):
            kind=command[1];name=command[-1]
            if command[2]=='inspect':
                if (kind,name) not in state:return subprocess.CompletedProcess(command,1,'','No such object')
                return subprocess.CompletedProcess(command,0,json.dumps([state[kind,name]]),'')
            attempted.append((kind,name))
            if name=='owned-timeout':raise subprocess.TimeoutExpired(command,30)
            state.pop((kind,name),None)
            return subprocess.CompletedProcess(command,0,'','')
        registry=OwnedResources(fake)
        for kind,name in [('container','owned-timeout'),('container','owned-keytool'),('volume','owned-volume'),('network','owned-network')]:
            registry.reserve(kind,name)
            labels={registry.label:registry.owner}
            state[kind,name]={'Config':{'Labels':labels}} if kind=='container' else {'Labels':labels}
        logs=[]
        def log_collector(name):
            logs.append(name)
            if name=='owned-timeout':raise subprocess.TimeoutExpired(['docker','logs',name],15)
        inventory=registry.cleanup(log_collector)
        self.assertEqual(len(logs),2)
        self.assertTrue(inventory['logErrors'])
        self.assertFalse(inventory['cleanupComplete'])
        self.assertEqual(len(attempted),4)
        self.assertTrue(all(x['absentVerified'] for x in inventory['resources'][1:]))
        self.assertTrue(inventory['resources'][0]['errors'])
        # A failed/timed-out launch is still owned before the daemon creates it.
        registry2=OwnedResources(fake)
        registry2.reserve('container','owned-partial-start')
        state['container','owned-partial-start']={'Config':{'Labels':{registry2.label:registry2.owner}}}
        self.assertTrue(registry2.cleanup()['cleanupComplete'])
        state['container','preexisting']={'Config':{'Labels':{'other':'owner'}}}
        with self.assertRaises(RuntimeError):registry2.reserve('container','preexisting')
        self.assertIn(('container','preexisting'),state)

    def test_scan_errors_cannot_leave_a_trusted_report(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            binaries=root/'bin'
            binaries.mkdir()
            programs={
                'python3': '#!/bin/sh\ncase "$1" in */fetch-apks.py|*/prepare-gosu.py) mkdir -p "$2";; *) exec '+shlex.quote(sys.executable)+' "$@";; esac\n',
                'docker': '#!/bin/sh\ncase "$1" in build) : > "$GG_VENDOR_TEST_STATE";; image) if [ -f "$GG_VENDOR_TEST_STATE" ]; then printf "[]\\n"; else exit 1; fi;; *) exit 2;; esac\n',
                'trivy': '#!/bin/sh\ncase "$*" in *--version*) echo mock-version; exit 0;; esac\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; report="$1"; fi; shift; done\nprintf \'%s\\n\' \'{"ArtifactName":"mock","ArtifactType":"container_image","Metadata":{"OS":{"Name":"test"}},"Results":[]}\' > "$report"\nexit 1\n',
            }
            for name, content in programs.items():
                path=binaries/name
                path.write_text(content)
                path.chmod(0o755)
            output=root/'evidence'
            environment=dict(os.environ, PATH=str(binaries)+os.pathsep+os.environ['PATH'],
                             GG_VENDOR_TEST_STATE=str(root/'built'))
            result=subprocess.run(['bash',str(HERE/'build-and-scan.sh'),str(output),'gg-mock-scan-error'],
                                  env=environment,capture_output=True,text=True)
            self.assertEqual(result.returncode,2,result.stderr)
            self.assertEqual(json.loads((output/'kafka-status.json').read_text())['status'],'scanner_failed')
            self.assertFalse((output/'kafka-trivy.json').exists())
            self.assertFalse((output/'findings.json').exists())

    def test_preparation_failure_is_operational_not_a_policy_finding(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);binaries=root/'bin';binaries.mkdir()
            for name, content in {'python3':'#!/bin/sh\nexit 1\n',
                                  'docker':'#!/bin/sh\ntouch "$GG_VENDOR_TEST_STATE"\nexit 9\n',
                                  'trivy':'#!/bin/sh\ntouch "$GG_VENDOR_TEST_STATE"\nexit 9\n'}.items():
                path=binaries/name;path.write_text(content);path.chmod(0o755)
            output=root/'evidence'
            environment=dict(os.environ,PATH=str(binaries)+os.pathsep+os.environ['PATH'],
                             GG_VENDOR_TEST_STATE=str(root/'unexpected'))
            result=subprocess.run(['bash',str(HERE/'build-and-scan.sh'),str(output),'gg-mock-prepare-error'],
                                  env=environment,capture_output=True,text=True)
            self.assertEqual(result.returncode,2,result.stderr)
            self.assertEqual(json.loads((output/'evidence-status.json').read_text())['stage'],'fetch-apks')
            self.assertFalse((root/'unexpected').exists())
            self.assertFalse((output/'findings.json').exists())

    def test_os_upgrade_has_locked_versions_urls_and_hashes(self):
        lock=json.loads((HERE/'kafka-apk-lock.json').read_text())
        self.assertEqual(lock['architecture'],'aarch64')
        self.assertEqual(len(lock['packages']),22)
        for package in lock['packages']:
            self.assertRegex(package['sha256'],r'^[a-f0-9]{64}$')
            self.assertTrue(package['url'].endswith('/'+package['filename']))
            self.assertEqual(package['filename'],f"{package['package']}-{package['version']}.apk")
        dockerfile=(HERE/'Dockerfile.kafka').read_text()
        self.assertIn('--repositories-file /dev/null --no-network',dockerfile)
        self.assertNotIn('--allow-untrusted',dockerfile)
        self.assertIn('USER 1000:1000',dockerfile)


if __name__=='__main__':
    unittest.main()
