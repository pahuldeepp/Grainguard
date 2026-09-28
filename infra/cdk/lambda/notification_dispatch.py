"""Critical-only SQS delivery directly to DynamoDB contacts and SES/SNS.

DynamoDB and a provider call cannot be committed atomically. The conditional claim is
therefore durable before send: a crash after claim is treated as UNKNOWN and is never
blindly sent again. Operators reconcile provider receipts and deliberately redrive only
when safe; there is no RabbitMQ/HTTP fallback.
"""

import hashlib
import json
import os
import re
import time
import uuid
from decimal import Decimal, InvalidOperation
from functools import lru_cache

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError, ParamValidationError

_NAMESPACE = uuid.UUID("5e3a0c51-8b4f-4c2e-9d77-610ad23b14e9")
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_EVENT_TYPES = {"alert.opened", "alert.escalated", "alert.resolved"}
_FEED_KEY = {"tenant_id": "SYSTEM#NOTIFICATION_CONTACTS_CDC", "record_key": "CONTACTS_FEED_HEARTBEAT"}
_FEED_MAX_AGE_MS = 60_000
_FEED_FUTURE_SKEW_MS = 5_000


def stable_intent_id(tenant_id: str, episode_id: str, version: int, channel: str) -> str:
    """Match jobs-worker IntentID (UUIDv5 of tenant|episode|version|channel)."""
    return str(uuid.uuid5(_NAMESPACE, f"{tenant_id}|{episode_id}|{version}|{channel}"))


def _version(raw):
    # boto3 deserializes DynamoDB N as Decimal. Reject floats and preserve precision.
    if isinstance(raw, bool) or isinstance(raw, float):
        raise ValueError("invalid contact projection version")
    try:
        value = raw if isinstance(raw, Decimal) else Decimal(str(raw))
    except (InvalidOperation, TypeError, ValueError) as error:
        raise ValueError("invalid contact projection version") from error
    if not value.is_finite() or value < 1 or value != value.to_integral_value():
        raise ValueError("invalid contact projection version")
    return value


def _validated_detail(record):
    envelope = json.loads(record["body"])
    detail = envelope.get("detail") if isinstance(envelope, dict) else None
    if (not isinstance(detail, dict) or envelope.get("source") != "greenguard.alerts"
            or envelope.get("detail-type") != "alert.critical.serverless"):
        raise ValueError("invalid critical notification envelope")
    payload = detail.get("payload")
    version = detail.get("aggregate_version")
    tenant = detail.get("tenant_id")
    episode = detail.get("aggregate_id")
    if (detail.get("schema_version") != 1 or detail.get("event_type") not in _EVENT_TYPES
            or detail.get("aggregate_type") != "alert_episode"
            or not isinstance(detail.get("event_id"), str) or not _UUID.fullmatch(detail["event_id"])
            or not isinstance(detail.get("correlation_id"), str) or not _UUID.fullmatch(detail["correlation_id"])
            or not isinstance(detail.get("causation_id"), str) or not _UUID.fullmatch(detail["causation_id"])
            or not isinstance(detail.get("traceparent"), str)
            or not re.fullmatch(r"00-[0-9a-f]{32}-[0-9a-f]{16}-(00|01)", detail["traceparent"])
            or payload is None or not isinstance(payload, dict)
            or payload.get("severity") != "critical"
            or payload.get("episode_id") != episode
            or payload.get("episode_version") != version
            or payload.get("state") != ("resolved" if detail["event_type"] == "alert.resolved" else "open")
            or not isinstance(tenant, str) or not _UUID.fullmatch(tenant)
            or not isinstance(episode, str) or not _UUID.fullmatch(episode)
            or not isinstance(version, str) or not re.fullmatch(r"[1-9][0-9]*", version)):
        raise ValueError("invalid critical notification detail")
    parsed_version = int(version)
    if parsed_version > 9223372036854775807:
        raise ValueError("aggregate version out of range")
    return detail, payload, tenant, episode, parsed_version


def _claim(table, *, tenant, intent_id, channel, contact_version):
    key = {"tenant_id": tenant, "record_key": f"DELIVERY#{intent_id}"}
    try:
        table.put_item(
            Item={**key, "intent_id": intent_id, "channel": channel,
                  "status": "UNKNOWN", "reason": "send_started",
                  "contact_version": contact_version},
            ConditionExpression="attribute_not_exists(tenant_id) AND attribute_not_exists(record_key)",
        )
        return True
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            prior = table.get_item(Key=key, ConsistentRead=True).get("Item", {})
            if prior.get("status") in {"UNKNOWN", "REJECTED"}:
                # Keep SQS retrying this record until it reaches the operator DLQ.
                # Never repeat a provider call whose outcome is ambiguous or rejected.
                raise RuntimeError("prior delivery outcome requires operator review")
            return False
        raise


def _finish(table, *, tenant, intent_id, channel, status, reason=None):
    values = {":status": status, ":started": "UNKNOWN"}
    update = "SET #status = :status"
    names = {"#status": "status"}
    if reason:
        values[":reason"] = reason[:80]
        update += ", reason = :reason"
    table.update_item(
        Key={"tenant_id": tenant, "record_key": f"DELIVERY#{intent_id}"},
        UpdateExpression=update,
        ConditionExpression="#status = :started",
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def _record_outcome(table, *, tenant, intent_id, channel, status, reason=None):
    """A failed outcome write leaves the durable pre-send UNKNOWN claim in place.

    The provider call may already have been accepted. Never retry it in this
    invocation; continue the other channel and make SQS/DLQ operator-visible.
    """
    try:
        _finish(table, tenant=tenant, intent_id=intent_id, channel=channel,
                status=status, reason=reason)
        return True
    except Exception as error:
        # Never log tenant, destination, event body, or provider response data.
        print(json.dumps({"level": "error", "component": "notification_dispatch",
                          "phase": "outcome_persist", "channel": channel,
                          "error": type(error).__name__}))
        return False


def _require_fresh_feed(table):
    # Feed health is separate from a contact's age: unchanged contacts may be valid
    # for months. Read the projector's durable source checkpoint before any claim.
    checkpoint = table.get_item(Key=_FEED_KEY, ConsistentRead=True).get("Item")
    if not checkpoint or any(checkpoint.get(key) != value for key, value in _FEED_KEY.items()):
        raise RuntimeError("contact feed checkpoint missing or mismatched")
    try:
        source_ms = _version(checkpoint.get("source_time_ms"))
    except ValueError as error:
        raise RuntimeError("contact feed checkpoint invalid") from error
    age_ms = Decimal(time.time_ns() // 1_000_000) - source_ms
    if age_ms > _FEED_MAX_AGE_MS or age_ms < -_FEED_FUTURE_SKEW_MS:
        raise RuntimeError("contact feed checkpoint stale or future")


def dispatch_one(record, *, table, ses, sns):
    detail, payload, tenant, episode, version = _validated_detail(record)
    _require_fresh_feed(table)
    contacts = table.get_item(Key={"tenant_id": tenant, "record_key": "CONTACTS"}, ConsistentRead=True).get("Item")
    if (not contacts or contacts.get("tenant_id") != tenant
            or contacts.get("record_key") != "CONTACTS"):
        # CDC projection lag or a corrupt projection is retriable and ultimately DLQed.
        raise RuntimeError("tenant contact projection is missing or mismatched")
    contact_version = _version(contacts.get("version"))
    # The event's tenant alone controls the DynamoDB key; tenant IDs from payload data are ignored.
    transition = detail["event_type"]
    subject = f"GreenGuard critical alert {transition.removeprefix('alert.')}"
    text = (f"A critical GreenGuard alert {transition.removeprefix('alert.')} "
            f"for episode {episode} is at version {version}.")
    results = []
    needs_review = False
    for channel, destination in (("email", contacts.get("email")), ("sms", contacts.get("sms"))):
        # The previous channel may take time: refresh before each new side-effect
        # claim rather than extending one freshness decision across both providers.
        _require_fresh_feed(table)
        channel_id = stable_intent_id(tenant, episode, version, channel)
        try:
            claimed = _claim(table, tenant=tenant, intent_id=channel_id, channel=channel, contact_version=contact_version)
        except RuntimeError:
            # A different channel in this same event may still be safely deliverable.
            needs_review = True
            results.append("unknown")
            continue
        if not destination:
            # Missing channel is explicit suppression, but a prior UNKNOWN claim
            # still requires operator review while allowing other channels to run.
            if claimed:
                recorded = _record_outcome(table, tenant=tenant, intent_id=channel_id,
                                           channel=channel, status="SUPPRESSED", reason="contact_missing")
                if not recorded:
                    needs_review = True
            else:
                recorded = True
            results.append("suppressed" if recorded else "unknown")
            continue
        if not claimed:
            results.append("duplicate")
            continue
        try:
            if channel == "email":
                sender = os.environ["SES_FROM_EMAIL"]
                ses.send_email(
                    Source=sender,
                    Destination={"ToAddresses": [destination]},
                    Message={"Subject": {"Data": subject}, "Body": {"Text": {"Data": text}}},
                )
            else:
                sns.publish(PhoneNumber=destination, Message=text, MessageAttributes={
                    "tenant_id": {"DataType": "String", "StringValue": tenant},
                    "intent_id": {"DataType": "String", "StringValue": channel_id},
                })
        except ParamValidationError as error:
            # SDK validation fails before submission, so the provider cannot have
            # accepted this call. Keep only the safe class name, not its report.
            recorded = _record_outcome(table, tenant=tenant, intent_id=channel_id,
                                       channel=channel, status="REJECTED",
                                       reason=type(error).__name__)
            needs_review = True
            results.append("rejected" if recorded else "unknown")
            continue
        except ClientError as error:
            code = error.response.get("Error", {}).get("Code", "ProviderError")
            rejected = code in {
                "MessageRejected", "MailFromDomainNotVerified", "ConfigurationSetDoesNotExist",
                "ConfigurationSetSendingPaused", "InvalidParameter", "InvalidParameterValue",
                "EndpointDisabled", "AuthorizationError", "OptedOut", "PlatformApplicationDisabled",
            }
            # These service responses explicitly reject the request; other SDK failures may
            # happen after acceptance and therefore stay UNKNOWN and never trigger a resend.
            recorded = _record_outcome(table, tenant=tenant, intent_id=channel_id, channel=channel,
                                       status="REJECTED" if rejected else "UNKNOWN", reason=code)
            needs_review = True
            results.append("rejected" if rejected and recorded else "unknown")
            continue
        except Exception as error:
            _record_outcome(table, tenant=tenant, intent_id=channel_id, channel=channel,
                            status="UNKNOWN", reason=type(error).__name__)
            needs_review = True
            results.append("unknown")
            continue
        recorded = _record_outcome(table, tenant=tenant, intent_id=channel_id,
                                   channel=channel, status="ACCEPTED")
        if not recorded:
            needs_review = True
        results.append("accepted" if recorded else "unknown")
    if needs_review:
        raise RuntimeError("one or more notification channels require operator review")
    return results


@lru_cache(maxsize=1)
def _aws_clients():
    """Reuse SDK connections in a warm runtime; cache_clear isolates test factories."""
    table = boto3.resource("dynamodb").Table(os.environ["NOTIFICATION_STATE_TABLE"])
    provider_config = BotoConfig(connect_timeout=3, read_timeout=8, retries={"total_max_attempts": 1})
    ses = boto3.client("ses", config=provider_config)
    sns = boto3.client("sns", config=provider_config)
    return table, ses, sns


def handler(event, _context):
    table, ses, sns = _aws_clients()
    failures = []
    for record in event.get("Records", []):
        try:
            dispatch_one(record, table=table, ses=ses, sns=sns)
        except Exception as error:
            # Do not log event bodies, destinations, or provider response details (PII).
            print(json.dumps({"level": "error", "messageId": record.get("messageId"),
                              "error": type(error).__name__,
                              "digest": hashlib.sha256(record.get("body", "").encode()).hexdigest()}))
            failures.append({"itemIdentifier": record["messageId"]})
    return {"batchItemFailures": failures}
