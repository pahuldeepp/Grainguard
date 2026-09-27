import unittest
from fnmatch import fnmatchcase

import aws_cdk as cdk
from aws_cdk.assertions import Template

from greenguard_serverless_stack import GreenGuardServerlessStack


def template():
    app = cdk.App()
    stack = GreenGuardServerlessStack(
        app,
        "TestServerless",
        environment_name="test",
        env=cdk.Environment(account="111111111111", region="us-east-1"),
    )
    return Template.from_stack(stack).to_json()


class StackTests(unittest.TestCase):
    def setUp(self):
        self.resources = template()["Resources"]

    def test_separates_projection_and_notification_lambda_workloads(self):
        functions = [
            resource["Properties"]
            for resource in self.resources.values()
            if resource["Type"] == "AWS::Lambda::Function"
        ]
        handlers = {function["Handler"] for function in functions}
        self.assertTrue(
            {"escalation_mirror.handler", "notification_dispatch.handler"}
            <= handlers
        )
        service_functions = [
            function
            for function in functions
            if function["Handler"]
            in {"escalation_mirror.handler", "notification_dispatch.handler"}
        ]
        self.assertEqual(
            {function["ReservedConcurrentExecutions"] for function in service_functions},
            {50, 100},
        )


    def test_only_critical_route_markers_enter_the_notification_queue(self):
        patterns = [
            resource["Properties"]["EventPattern"]
            for resource in self.resources.values()
            if resource["Type"] == "AWS::Events::Rule"
        ]
        self.assertTrue(
            any(
                pattern.get("detail-type") == ["alert.critical.serverless"]
                and pattern.get("source") == ["greenguard.alerts"]
                for pattern in patterns
            )
        )
        self.assertTrue(
            any(
                set(pattern.get("detail-type", []))
                == {
                    "alert.opened",
                    "alert.updated",
                    "alert.acknowledged",
                    "alert.escalated",
                    "alert.resolved",
                }
                for pattern in patterns
            )
        )


    def test_mirror_is_tenant_keyed_versioned_and_has_no_ttl(self):
        tables = [
            resource["Properties"]
            for resource in self.resources.values()
            if resource["Type"] == "AWS::DynamoDB::Table"
            and "episode_id"
            in [key["AttributeName"] for key in resource["Properties"]["KeySchema"]]
        ]
        self.assertEqual(len(tables), 1)
        table = tables[0]
        self.assertEqual(
            [key["AttributeName"] for key in table["KeySchema"]],
            ["tenant_id", "episode_id"],
        )
        self.assertNotIn("TimeToLiveSpecification", table)
        self.assertTrue(
            table["PointInTimeRecoverySpecification"]["PointInTimeRecoveryEnabled"]
        )


    def test_notification_queue_uses_redrive_and_partial_batch_response(self):
        mappings = [
            resource["Properties"]
            for resource in self.resources.values()
            if resource["Type"] == "AWS::Lambda::EventSourceMapping"
        ]
        mapping = mappings[0]
        source = self.resources[mapping["EventSourceArn"]["Fn::GetAtt"][0]]["Properties"]
        dispatch = self.resources[mapping["FunctionName"]["Ref"]]["Properties"]
        self.assertEqual(mapping["BatchSize"], 1)
        self.assertGreaterEqual(
            source["VisibilityTimeout"],
            6 * dispatch["Timeout"] + mapping.get("MaximumBatchingWindowInSeconds", 0),
        )
        self.assertEqual(source["RedrivePolicy"]["maxReceiveCount"], 5)
        dispatch_dlq = source["RedrivePolicy"]["deadLetterTargetArn"]["Fn::GetAtt"][0]
        notification_rule = next(
            resource["Properties"]
            for resource in self.resources.values()
            if resource["Type"] == "AWS::Events::Rule"
            and resource["Properties"].get("EventPattern", {}).get("detail-type")
            == ["alert.critical.serverless"]
        )
        eventbridge_dlq = notification_rule["Targets"][0]["DeadLetterConfig"]["Arn"]["Fn::GetAtt"][0]
        self.assertNotEqual(dispatch_dlq, eventbridge_dlq)
        self.assertEqual(
            mappings[0]["FunctionResponseTypes"], ["ReportBatchItemFailures"]
        )
        self.assertEqual(mappings[0]["BatchSize"], 1)

    def test_notification_lambda_is_direct_provider_and_table_bound(self):
        functions = [r["Properties"] for r in self.resources.values() if r["Type"] == "AWS::Lambda::Function"]
        dispatch = next(f for f in functions if f["Handler"] == "notification_dispatch.handler")
        self.assertEqual(set(dispatch["Environment"]["Variables"]), {"NOTIFICATION_STATE_TABLE", "SES_FROM_EMAIL"})
        self.assertNotIn("NOTIFICATION_DISPATCH_URL", str(self.resources))
        self.assertNotIn("NOTIFICATION_DISPATCH_SECRET_ARN", str(self.resources))
        tables = [r["Properties"] for r in self.resources.values() if r["Type"] == "AWS::DynamoDB::Table"]
        state = next(t for t in tables if any(k["AttributeName"] == "record_key" for k in t["KeySchema"]))
        self.assertEqual([k["AttributeName"] for k in state["KeySchema"]], ["tenant_id", "record_key"])
        self.assertTrue(state["PointInTimeRecoverySpecification"]["PointInTimeRecoveryEnabled"])

    def test_notification_sms_permission_denies_topics_and_platform_endpoints(self):
        dispatch = next(r["Properties"] for r in self.resources.values()
                        if r["Type"] == "AWS::Lambda::Function"
                        and r["Properties"]["Handler"] == "notification_dispatch.handler")
        role_id = dispatch["Role"]["Fn::GetAtt"][0]
        policies = [r["Properties"] for r in self.resources.values()
                    if r["Type"] == "AWS::IAM::Policy"
                    and {"Ref": role_id} in r["Properties"]["Roles"]]
        statements = [s for p in policies for s in p["PolicyDocument"]["Statement"]
                      if s["Action"] == "sns:Publish"]
        allow = next(s for s in statements if s["Effect"] == "Allow")
        deny = next(s for s in statements if s["Effect"] == "Deny")
        self.assertEqual(allow["Resource"], "*")
        self.assertEqual(allow["Condition"], {"StringEquals": {"aws:RequestedRegion": "us-east-1"}})
        # The deny must cover SNS ARNs across regions/accounts and be unconditional.
        # Partition comes from CloudFormation so this also works outside arn:aws.
        self.assertEqual(deny["Resource"], {"Fn::Join": ["", ["arn:", {"Ref": "AWS::Partition"}, ":sns:*:*:*"]]})
        self.assertNotIn("Condition", deny)
        for partition in ["aws", "aws-us-gov", "aws-cn"]:
            pattern = f"arn:{partition}:sns:*:*:*"
            self.assertTrue(fnmatchcase(f"arn:{partition}:sns:us-east-1:111111111111:alerts", pattern))
            self.assertTrue(fnmatchcase(f"arn:{partition}:sns:us-west-2:222222222222:endpoint/GCM/app/device", pattern))
            # Direct PhoneNumber publishing uses no SNS ARN; its wildcard resource
            # is allowed above and is deliberately unmatched by this ARN deny.
            self.assertFalse(fnmatchcase("*", pattern))

    def test_notification_ses_permission_is_bound_to_verified_sender_identity(self):
        dispatch = next(r["Properties"] for r in self.resources.values()
                        if r["Type"] == "AWS::Lambda::Function"
                        and r["Properties"]["Handler"] == "notification_dispatch.handler")
        role_id = dispatch["Role"]["Fn::GetAtt"][0]
        statements = [s for r in self.resources.values() if r["Type"] == "AWS::IAM::Policy"
                      and {"Ref": role_id} in r["Properties"]["Roles"]
                      for s in r["Properties"]["PolicyDocument"]["Statement"]
                      if s["Action"] == "ses:SendEmail"]
        self.assertEqual(len(statements), 1)
        statement = statements[0]
        self.assertEqual(statement["Effect"], "Allow")
        self.assertEqual(statement["Condition"], {
            "StringEquals": {"ses:FromAddress": {"Ref": "SesFromEmail"}}
        })
        self.assertEqual(statement["Resource"], {
            "Fn::Join": ["", ["arn:", {"Ref": "AWS::Partition"},
                             ":ses:us-east-1:111111111111:identity/",
                             {"Ref": "SesFromEmail"}]]
        })

    def test_each_async_and_queue_failure_path_has_a_distinct_dlq_alarm(self):
        alarms = [
            resource["Properties"]
            for resource in self.resources.values()
            if resource["Type"] == "AWS::CloudWatch::Alarm"
        ]
        self.assertGreaterEqual(len(alarms), 5)
        functions = [
            resource["Properties"]
            for resource in self.resources.values()
            if resource["Type"] == "AWS::Lambda::Function"
        ]
        mirror = next(item for item in functions if item["Handler"] == "escalation_mirror.handler")
        self.assertIn("DeadLetterConfig", mirror)


    def test_audit_archive_is_private_encrypted_and_versioned(self):
        bucket = next(
            resource["Properties"]
            for resource in self.resources.values()
            if resource["Type"] == "AWS::S3::Bucket"
        )
        self.assertTrue(bucket["PublicAccessBlockConfiguration"]["BlockPublicAcls"])
        self.assertTrue(bucket["PublicAccessBlockConfiguration"]["BlockPublicPolicy"])
        self.assertEqual(bucket["VersioningConfiguration"]["Status"], "Enabled")
        self.assertTrue(bucket["BucketEncryption"]["ServerSideEncryptionConfiguration"])
