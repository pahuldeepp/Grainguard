"""Offline acceptance fixtures for the cell-owned public edge checker."""
import copy
import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("public_edge", Path(__file__).with_name("check-public-edge.py"))
edge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(edge)


class PublicEdgeTests(unittest.TestCase):
    def setUp(self):
        self.cell = {"region": "us-east-1", "environment": "sandbox", "cluster_name": "greenguard-sandbox",
                     "account_id": "123456789012"}
        self.tg = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/ggmsh-abc/0123456789abcdef"
        self.lb_arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/gg-edge/0123456789abcdef"
        self.web_id, self.api_id = "E1234567890WEB", "E1234567890API"
        self.web_url, self.api_url = "https://dweb123.cloudfront.net", "https://dapi123.cloudfront.net/graphql"
        self.lb_dns = "internal-gg-edge-123.us-east-1.elb.amazonaws.com"
        self.aws_calls = []
        self.responses = {
            ("sts", "get-caller-identity"): {"Account": self.cell["account_id"]},
            ("elbv2", "describe-target-groups"): {"TargetGroups": [{
                "TargetGroupArn": self.tg, "TargetType": "ip", "Protocol": "HTTP", "Port": 8080,
                "LoadBalancerArns": [self.lb_arn]}]},
            ("elbv2", "describe-tags", self.tg): {"TagDescriptions": [{"ResourceArn": self.tg, "Tags": [
                {"Key": "Cell", "Value": self.cell["cluster_name"]}]}]},
            ("elbv2", "describe-load-balancers"): {"LoadBalancers": [{
                "LoadBalancerArn": self.lb_arn, "Scheme": "internal", "Type": "application",
                "DNSName": self.lb_dns}]},
            ("elbv2", "describe-tags", self.lb_arn): {"TagDescriptions": [{"ResourceArn": self.lb_arn, "Tags": [
                {"Key": "Name", "Value": self.cell["cluster_name"] + "-edge"}]}]},
            ("elbv2", "describe-target-health"): {"TargetHealthDescriptions": [{
                "Target": {"Id": "10.0.1.2", "Port": 8080}, "TargetHealth": {"State": "healthy"}}]},
        }
        for identifier, role, host in ((self.web_id, "dashboard", "dweb123.cloudfront.net"),
                                       (self.api_id, "bff", "dapi123.cloudfront.net")):
            vpc_id = "vo_" + identifier
            vpc_arn = f"arn:aws:cloudfront::{self.cell['account_id']}:vpc-origin/{vpc_id}"
            self.responses[("cloudfront", "get-distribution", identifier)] = {"Distribution": {
                "Id": identifier, "Status": "Deployed", "DomainName": host,
                "DistributionConfig": {"Enabled": True, "Aliases": {"Quantity": 0},
                    "Origins": {"Quantity": 1, "Items": [{"DomainName": self.lb_dns,
                        "VpcOriginConfig": {"VpcOriginId": vpc_id},
                        "CustomHeaders": {"Quantity": 1, "Items": [{"HeaderName": "X-GreenGuard-Origin",
                                                                          "HeaderValue": role}]}}]}}}}
            self.responses[("cloudfront", "list-tags-for-resource", identifier)] = {"Tags": {"Items": [
                {"Key": "Cell", "Value": self.cell["cluster_name"]}]}}
            self.responses[("cloudfront", "get-vpc-origin", vpc_id)] = {"VpcOrigin": {
                "Id": vpc_id, "Arn": vpc_arn, "AccountId": self.cell["account_id"], "Status": "Deployed",
                "VpcOriginEndpointConfig": {"Name": "gg-edge-shortened-name", "Arn": self.lb_arn}}}
            self.responses[("cloudfront", "list-tags-for-resource", vpc_id)] = {"Tags": {"Items": [
                {"Key": "Cell", "Value": self.cell["cluster_name"]}]}}

    def fake_aws(self, *args):
        self.aws_calls.append(args)
        key = tuple(args[:2])
        if args[:2] == ("cloudfront", "get-distribution"):
            key = (*key, args[3])
        elif args[:2] == ("cloudfront", "get-vpc-origin"):
            key = (*key, args[3])
        elif args[:2] == ("cloudfront", "list-tags-for-resource"):
            resource = args[3]
            key = (*key, resource.rsplit("/", 1)[-1])
        elif args[:2] == ("elbv2", "describe-tags"):
            resource = args[-1]
            key = (*key, resource)
        return copy.deepcopy(self.responses[key])

    def fake_probe(self, url):
        if url == self.web_url + "/":
            return 200, "text/html; charset=utf-8", b"<!doctype html><title>GreenGuard</title>"
        return 204, "", b""

    def run_check(self):
        return edge.check_public_edge(self.cell, self.tg, self.web_url, self.api_url,
                                      self.web_id, self.api_id, self.fake_aws, self.fake_probe)

    def test_owned_edge_and_safe_https_probes_pass(self):
        outcomes = self.run_check()
        self.assertIn("healthy ingress targets", outcomes)
        self.assertIn("dashboard HTML", outcomes)
        self.assertIn("BFF /readyz", outcomes)
        self.assertTrue(any(call[:2] == ("cloudfront", "get-distribution") for call in self.aws_calls))

    def test_refuses_production_foreign_account_or_wrong_tg_scope(self):
        with self.assertRaisesRegex(edge.EdgeCheckError, "production"):
            edge.check_public_edge(dict(self.cell, environment="production"), self.tg, self.web_url, self.api_url,
                                   self.web_id, self.api_id, self.fake_aws, self.fake_probe)
        self.responses[("sts", "get-caller-identity")] = {"Account": "999999999999"}
        with self.assertRaisesRegex(edge.EdgeCheckError, "current AWS account"):
            self.run_check()
        with self.assertRaisesRegex(edge.EdgeCheckError, "account and region"):
            edge.validate_scope(self.cell, self.tg.replace("us-east-1", "us-west-2"))

    def test_requires_registered_all_healthy_target_and_cell_tagged_resources(self):
        self.responses[("elbv2", "describe-target-health")]["TargetHealthDescriptions"].append(
            {"Target": {"Id": "10.0.1.3", "Port": 8080}, "TargetHealth": {"State": "unused"}})
        with self.assertRaisesRegex(edge.EdgeCheckError, "non-healthy"):
            self.run_check()
        self.responses[("elbv2", "describe-target-health")] = {"TargetHealthDescriptions": []}
        with self.assertRaisesRegex(edge.EdgeCheckError, "no registered"):
            self.run_check()
        self.responses[("elbv2", "describe-target-health")] = {"TargetHealthDescriptions": [{
            "TargetHealth": {"State": "healthy"}}]}
        self.responses[("cloudfront", "list-tags-for-resource", self.web_id)]["Tags"]["Items"][0]["Value"] = "another-cell"
        with self.assertRaisesRegex(edge.EdgeCheckError, "not tagged"):
            self.run_check()

    def test_empty_or_ambiguous_elbv2_tag_responses_fail_closed(self):
        for descriptions in ([], [None], ["not-a-description"], None):
            with self.subTest(descriptions=descriptions):
                self.responses[("elbv2", "describe-tags", self.tg)] = {"TagDescriptions": descriptions}
                with self.assertRaisesRegex(edge.EdgeCheckError, "missing or ambiguous"):
                    self.run_check()

    def test_rejects_arbitrary_host_wrong_cloudfront_route_or_alias(self):
        with self.assertRaisesRegex(edge.EdgeCheckError, "AWS-owned CloudFront"):
            edge.validate_public_url("https://attacker.example/", "dashboard")
        with self.assertRaisesRegex(edge.EdgeCheckError, "does not match"):
            edge.check_public_edge(self.cell, self.tg, "https://dother.cloudfront.net", self.api_url,
                                   self.web_id, self.api_id, self.fake_aws, self.fake_probe)
        config = self.responses[("cloudfront", "get-distribution", self.api_id)]["Distribution"]["DistributionConfig"]
        config["Origins"]["Items"][0]["CustomHeaders"]["Items"][0]["HeaderValue"] = "dashboard"
        with self.assertRaisesRegex(edge.EdgeCheckError, "origin does not select"):
            self.run_check()
        config["Origins"]["Items"][0]["CustomHeaders"]["Items"][0]["HeaderValue"] = "bff"
        config["Aliases"] = {"Quantity": 1, "Items": ["attacker.example"]}
        with self.assertRaisesRegex(edge.EdgeCheckError, "AWS-owned"):
            self.run_check()

    def test_vpc_origin_must_belong_to_the_cell_and_terminate_at_its_alb(self):
        vpc_id = "vo_" + self.web_id
        self.responses[("cloudfront", "get-vpc-origin", vpc_id)]["VpcOrigin"]["VpcOriginEndpointConfig"]["Arn"] = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/other/0123456789abcdef"
        with self.assertRaisesRegex(edge.EdgeCheckError, "VPC origin is not"):
            self.run_check()

    def test_malformed_target_health_entries_fail_closed_without_traceback(self):
        for target in (None, {"TargetHealth": None}, {"TargetHealth": {"State": []}}):
            with self.subTest(target=target):
                self.responses[("elbv2", "describe-target-health")] = {"TargetHealthDescriptions": [target]}
                with self.assertRaisesRegex(edge.TransientEdgeCheckError, "non-healthy.*unknown"):
                    self.run_check()

    def test_dashboard_and_bff_health_are_checked_without_printing_bodies(self):
        with self.assertRaisesRegex(edge.EdgeCheckError, "GreenGuard HTML"):
            edge.check_public_edge(self.cell, self.tg, self.web_url, self.api_url,
                                   self.web_id, self.api_id, self.fake_aws,
                                   lambda _: (200, "text/html", b"sensitive page body"))
        with self.assertRaisesRegex(edge.EdgeCheckError, "BFF public /readyz"):
            edge.check_public_edge(self.cell, self.tg, self.web_url, self.api_url,
                                   self.web_id, self.api_id, self.fake_aws,
                                   lambda url: (200, "text/html", b"GreenGuard") if url.endswith("/") else
                                   (204, "", b"") if url.endswith("/healthz") else (503, "", b"secret"))


if __name__ == "__main__":
    unittest.main()
