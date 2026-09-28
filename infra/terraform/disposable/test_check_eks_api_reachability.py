import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

SCRIPT = Path(__file__).with_name("check-eks-api-reachability.py")
spec = importlib.util.spec_from_file_location("check_eks_api_reachability", SCRIPT)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class EKSReachabilityGateTests(unittest.TestCase):
    def setUp(self):
        self.cluster = "gg-cell"
        self.account = "123456789012"
        self.region = "us-east-1"

    def test_validates_input_before_any_external_command(self):
        command = Mock()
        for environment in ("prod", "production", "Production", "PROD"):
            with self.subTest(environment=environment), self.assertRaises(ValueError):
                gate.check(self.account, self.region, environment, self.cluster, command)
        command.assert_not_called()

    def test_requires_exact_aws_account(self):
        command = Mock(return_value=subprocess.CompletedProcess([], 0, "999999999999\n", ""))
        with self.assertRaisesRegex(ValueError, "caller account"):
            gate.check(self.account, self.region, "sandbox", self.cluster, command)
        self.assertEqual(command.call_count, 1)

    def test_requires_exact_active_cluster(self):
        command = Mock(side_effect=[
            subprocess.CompletedProcess([], 0, self.account, ""),
            subprocess.CompletedProcess([], 0, json.dumps({
                "arn": f"arn:aws:eks:{self.region}:{self.account}:cluster/other",
                "status": "ACTIVE", "endpoint": "https://example.eks.amazonaws.com",
            }), ""),
        ])
        with self.assertRaisesRegex(ValueError, "identity or status"):
            gate.check(self.account, self.region, "sandbox", self.cluster, command)
        self.assertEqual(command.call_count, 2)

    def test_checks_api_readiness_and_kubernetes_authorization(self):
        calls = []

        def command(args, **kwargs):
            calls.append(args)
            if args[:3] == ["aws", "sts", "get-caller-identity"]:
                return subprocess.CompletedProcess(args, 0, self.account, "")
            if args[:3] == ["aws", "eks", "describe-cluster"]:
                return subprocess.CompletedProcess(args, 0, json.dumps({
                    "arn": f"arn:aws:eks:{self.region}:{self.account}:cluster/{self.cluster}",
                    "status": "ACTIVE", "endpoint": "https://example.eks.amazonaws.com",
                }), "")
            if args[:3] == ["aws", "eks", "update-kubeconfig"]:
                Path(args[args.index("--kubeconfig") + 1]).write_text("generated")
                return subprocess.CompletedProcess(args, 0, "", "")
            if args[-1] == "--raw=/readyz":
                return subprocess.CompletedProcess(args, 0, "ok\n", "")
            if args[-4:] == ["get", "pods", "--namespace", "kube-system"]:
                return subprocess.CompletedProcess(args, 0, "yes\n", "")
            self.fail(f"unexpected command: {args}")

        gate.check(self.account, self.region, "sandbox", self.cluster, command)
        self.assertEqual(len(calls), 5)
        self.assertIn("--kubeconfig", calls[2])
        self.assertIn("--request-timeout=20s", calls[3])

    def test_api_or_authorization_failure_fails_closed(self):
        calls = []

        def command(args, **kwargs):
            calls.append(args)
            if args[0:3] == ["aws", "sts", "get-caller-identity"]:
                return subprocess.CompletedProcess(args, 0, self.account, "")
            if args[0:3] == ["aws", "eks", "describe-cluster"]:
                return subprocess.CompletedProcess(args, 0, json.dumps({
                    "arn": f"arn:aws:eks:{self.region}:{self.account}:cluster/{self.cluster}",
                    "status": "ACTIVE", "endpoint": "https://example.eks.amazonaws.com",
                }), "")
            if args[0:3] == ["aws", "eks", "update-kubeconfig"]:
                Path(args[args.index("--kubeconfig") + 1]).write_text("generated")
                return subprocess.CompletedProcess(args, 0, "", "")
            return subprocess.CompletedProcess(args, 1, "", "network timeout")

        with self.assertRaisesRegex(ValueError, "not reachable"):
            gate.check(self.account, self.region, "sandbox", self.cluster, command)
        self.assertEqual(len(calls), 4)


if __name__ == "__main__":
    unittest.main()
