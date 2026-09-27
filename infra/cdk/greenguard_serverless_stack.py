from aws_cdk import (
    ArnFormat,
    CfnParameter,
    CfnOutput,
    Duration,
    RemovalPolicy,
    Stack,
    aws_cloudwatch as cloudwatch,
    aws_dynamodb as dynamodb,
    aws_events as events,
    aws_events_targets as targets,
    aws_iam as iam,
    aws_lambda as lambda_,
    aws_lambda_event_sources as lambda_events,
    aws_s3 as s3,
    aws_sqs as sqs,
)
from constructs import Construct


ALERT_EVENTS = [
    "alert.opened",
    "alert.updated",
    "alert.acknowledged",
    "alert.escalated",
    "alert.resolved",
]


class GreenGuardServerlessStack(Stack):
    """Optional burst-processing profile; PostgreSQL/Kafka remain canonical."""

    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        environment_name: str = "dev",
        **kwargs,
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)
        if not environment_name.replace("-", "").isalnum():
            raise ValueError("environment name must be alphanumeric or hyphenated")

        is_prod = environment_name == "prod"
        removal = RemovalPolicy.RETAIN if is_prod else RemovalPolicy.DESTROY

        self.alert_bus = events.EventBus(
            self, "AlertBus", event_bus_name=f"greenguard-alerts-{environment_name}"
        )
        bridge_quarantine = sqs.Queue(
            self, "BridgeQuarantine",
            encryption=sqs.QueueEncryption.SQS_MANAGED,
            enforce_ssl=True,
            retention_period=Duration.days(14),
            removal_policy=removal,
        )
        bridge_role = iam.Role(
            self, "KafkaBridgeRole",
            assumed_by=iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
        )
        bridge_role.add_to_policy(iam.PolicyStatement(
            actions=["events:PutEvents"], resources=[self.alert_bus.event_bus_arn]
        ))
        bridge_quarantine.grant_send_messages(bridge_role)
        self.escalation_table = dynamodb.Table(
            self,
            "EscalationMirror",
            table_name=f"greenguard-escalation-mirror-{environment_name}",
            partition_key=dynamodb.Attribute(
                name="tenant_id", type=dynamodb.AttributeType.STRING
            ),
            sort_key=dynamodb.Attribute(
                name="episode_id", type=dynamodb.AttributeType.STRING
            ),
            billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
            point_in_time_recovery_specification=dynamodb.PointInTimeRecoverySpecification(
                point_in_time_recovery_enabled=True
            ),
            encryption=dynamodb.TableEncryption.AWS_MANAGED,
            removal_policy=removal,
        )

        self.audit_archive = s3.Bucket(
            self,
            "AuditArchive",
            bucket_name=None,
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            versioned=True,
            object_ownership=s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
            removal_policy=removal,
            auto_delete_objects=not is_prod,
        )

        mirror_dlq = sqs.Queue(
            self,
            "EscalationMirrorDlq",
            encryption=sqs.QueueEncryption.SQS_MANAGED,
            enforce_ssl=True,
            retention_period=Duration.days(14),
            removal_policy=removal,
        )
        mirror_invoke_dlq = sqs.Queue(
            self,
            "EscalationMirrorInvokeDlq",
            encryption=sqs.QueueEncryption.SQS_MANAGED,
            enforce_ssl=True,
            retention_period=Duration.days(14),
            removal_policy=removal,
        )
        mirror = lambda_.Function(
            self,
            "EscalationMirrorLambda",
            function_name=f"greenguard-escalation-mirror-{environment_name}",
            runtime=lambda_.Runtime.PYTHON_3_12,
            handler="escalation_mirror.handler",
            code=lambda_.Code.from_asset("lambda"),
            timeout=Duration.seconds(10),
            memory_size=256,
            reserved_concurrent_executions=50,
            dead_letter_queue=mirror_invoke_dlq,
            environment={"ESCALATION_TABLE": self.escalation_table.table_name},
        )
        self.escalation_table.grant_write_data(mirror)
        events.Rule(
            self,
            "MirrorLifecycleEvents",
            event_bus=self.alert_bus,
            event_pattern=events.EventPattern(
                source=["greenguard.alerts"], detail_type=ALERT_EVENTS
            ),
        ).add_target(
            targets.LambdaFunction(
                mirror,
                dead_letter_queue=mirror_dlq,
                retry_attempts=5,
                max_event_age=Duration.hours(2),
            )
        )

        notification_dlq = sqs.Queue(
            self,
            "NotificationDlq",
            encryption=sqs.QueueEncryption.SQS_MANAGED,
            enforce_ssl=True,
            retention_period=Duration.days(14),
            removal_policy=removal,
        )
        notification_rule_dlq = sqs.Queue(
            self,
            "NotificationRuleDlq",
            encryption=sqs.QueueEncryption.SQS_MANAGED,
            enforce_ssl=True,
            retention_period=Duration.days(14),
            removal_policy=removal,
        )
        notification_queue = sqs.Queue(
            self,
            "NotificationQueue",
            encryption=sqs.QueueEncryption.SQS_MANAGED,
            enforce_ssl=True,
            retention_period=Duration.days(4),
            # Six 30-second Lambda timeouts plus extra operational headroom.
            visibility_timeout=Duration.seconds(182),
            dead_letter_queue=sqs.DeadLetterQueue(
                max_receive_count=5, queue=notification_dlq
            ),
            removal_policy=removal,
        )
        notification_rule = events.Rule(
            self,
            "EscalatedNotificationRule",
            event_bus=self.alert_bus,
            event_pattern=events.EventPattern(
                source=["greenguard.alerts"], detail_type=["alert.critical.serverless"]
            ),
        )
        notification_rule.add_target(
            targets.SqsQueue(
                notification_queue,
                dead_letter_queue=notification_rule_dlq,
                retry_attempts=5,
                max_event_age=Duration.hours(2),
            )
        )

        notification_state_table = dynamodb.Table(
            self,
            "NotificationState",
            table_name=f"greenguard-notification-state-{environment_name}",
            partition_key=dynamodb.Attribute(name="tenant_id", type=dynamodb.AttributeType.STRING),
            sort_key=dynamodb.Attribute(name="record_key", type=dynamodb.AttributeType.STRING),
            billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
            point_in_time_recovery_specification=dynamodb.PointInTimeRecoverySpecification(
                point_in_time_recovery_enabled=True
            ),
            encryption=dynamodb.TableEncryption.AWS_MANAGED,
            removal_policy=removal,
        )
        ses_from = CfnParameter(
            self, "SesFromEmail", type="String",
            description="Verified SES sender address for critical GreenGuard email alerts.",
            allowed_pattern=r"[^\s@]+@[^\s@]+\.[^\s@]+",
        )
        dispatch = lambda_.Function(
            self,
            "NotificationDispatchLambda",
            function_name=f"greenguard-notification-dispatch-{environment_name}",
            runtime=lambda_.Runtime.PYTHON_3_12,
            handler="notification_dispatch.handler",
            code=lambda_.Code.from_asset("lambda"),
            timeout=Duration.seconds(30),
            memory_size=256,
            reserved_concurrent_executions=100,
            environment={
                "NOTIFICATION_STATE_TABLE": notification_state_table.table_name,
                "SES_FROM_EMAIL": ses_from.value_as_string,
            },
        )
        dispatch.add_to_role_policy(iam.PolicyStatement(
            actions=["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
            resources=[notification_state_table.table_arn],
        ))
        dispatch.add_to_role_policy(iam.PolicyStatement(
            actions=["ses:SendEmail"],
            resources=[self.format_arn(
                service="ses", resource="identity", resource_name=ses_from.value_as_string,
                arn_format=ArnFormat.SLASH_RESOURCE_NAME,
            )],
            conditions={"StringEquals": {"ses:FromAddress": ses_from.value_as_string}},
        ))
        # SNS SMS publish currently requires Resource="*"; constrain it to SMS and this region.
        dispatch.add_to_role_policy(iam.PolicyStatement(
            actions=["sns:Publish"], resources=["*"],
            conditions={"StringEquals": {"aws:RequestedRegion": self.region}},
        ))
        # PhoneNumber SMS has no SNS resource ARN. Explicitly deny every SNS ARN
        # (topics and platform endpoints, across accounts/regions) so the wildcard
        # Publish allowance cannot be used to send through those destinations.
        dispatch.add_to_role_policy(iam.PolicyStatement(
            effect=iam.Effect.DENY,
            actions=["sns:Publish"],
            resources=[self.format_arn(service="sns", region="*", account="*", resource="*")],
        ))
        dispatch.add_event_source(
            lambda_events.SqsEventSource(
                notification_queue,
                # One record per invocation bounds external side effects; partial failures
                # are still reported so the SQS message retries independently.
                batch_size=1,
                report_batch_item_failures=True,
            )
        )

        for alarm_id, queue in (
            ("BridgeQuarantineDepth", bridge_quarantine),
            ("MirrorEventDeliveryDlqDepth", mirror_dlq),
            ("MirrorInvokeDlqDepth", mirror_invoke_dlq),
            ("NotificationRuleDlqDepth", notification_rule_dlq),
            ("NotificationDispatchDlqDepth", notification_dlq),
        ):
            cloudwatch.Alarm(
                self,
                alarm_id,
                metric=queue.metric_approximate_number_of_messages_visible(
                    period=Duration.minutes(1), statistic="Maximum"
                ),
                threshold=1,
                evaluation_periods=1,
                datapoints_to_alarm=1,
                treat_missing_data=cloudwatch.TreatMissingData.NOT_BREACHING,
                alarm_description=f"GreenGuard serverless queue {queue.queue_name} has messages requiring operator review.",
            )

        CfnOutput(self, "AlertBusName", value=self.alert_bus.event_bus_name)
        CfnOutput(self, "EscalationMirrorTable", value=self.escalation_table.table_name)
        CfnOutput(self, "NotificationQueueUrl", value=notification_queue.queue_url)
        CfnOutput(self, "NotificationStateTable", value=notification_state_table.table_name)
        CfnOutput(self, "AuditArchiveBucket", value=self.audit_archive.bucket_name)
        CfnOutput(self, "BridgeRoleArn", value=bridge_role.role_arn)
        CfnOutput(self, "BridgeQuarantineQueueUrl", value=bridge_quarantine.queue_url)
