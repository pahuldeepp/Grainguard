"""Offline checks; actual runsc invocation belongs to the Argo parser gate."""
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent

class ParserRuntimeTests(unittest.TestCase):
    def test_pinned_complete_release_and_shell_syntax(self):
        content = (HERE / 'parser-node-user-data.tpl').read_text()
        self.assertIn('release-20260928.0/gvisor-x86_64.tar.bz2', content)
        self.assertIn('sha512sum --check', content)
        self.assertNotIn('/latest/', content)
        self.assertIn('nodeadm.d/50-greenguard-parser.yaml', content)
        script = content.split('#!/bin/bash', 1)[1].split('--GREENGUARD-PARSER--', 1)[0]
        result = subprocess.run(['bash', '-n'], input='#!/bin/bash'+script, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_owned_runtime_schedules_only_dedicated_nodes(self):
        chart = ROOT / 'infra/gitops/disposable/parser-runtime-chart'
        result = subprocess.run(['helm','template','parser-runtime',str(chart),'--set','cell=unit-test'], text=True,capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('name: greenguard-parser-runsc',result.stdout)
        self.assertIn('handler: runsc',result.stdout)
        self.assertIn('greenguard.io/workload-class: parser',result.stdout)
        self.assertIn('effect: NoSchedule',result.stdout)
        node = (HERE / 'parser-runtime.tf').read_text()
        self.assertIn('AL2023_x86_64_STANDARD',node)
        self.assertIn('http_tokens                 = "required"',node)
        self.assertIn('delete_on_termination = true',node)

if __name__ == '__main__': unittest.main()
