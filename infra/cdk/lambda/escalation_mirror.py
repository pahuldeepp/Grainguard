"""DynamoDB projection of canonical alert lifecycle events; never an alert owner."""

import os
import re
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
ALERT_TYPES = {
    "alert.opened",
    "alert.updated",
    "alert.acknowledged",
    "alert.escalated",
    "alert.resolved",
}
_table = None


def _event_detail(event: dict) -> dict:
    if event.get("source") != "greenguard.alerts":
        raise ValueError("unexpected alert event source")
    detail_type = event.get("detail-type")
    detail = event.get("detail")
    if detail_type not in ALERT_TYPES or not isinstance(detail, dict):
        raise ValueError("invalid alert lifecycle envelope")
    payload = detail.get("payload")
    allowed_states = {
        "alert.opened": {"open"},
        "alert.updated": {"open", "acknowledged"},
        "alert.acknowledged": {"acknowledged"},
        "alert.escalated": {"open"},
        "alert.resolved": {"resolved"},
    }
    tenant = detail.get("tenant_id")
    episode = detail.get("aggregate_id")
    version = detail.get("aggregate_version")
    if (
        detail.get("event_type") != detail_type
        or type(detail.get("schema_version")) is not int
        or detail.get("schema_version") != 1
        or detail.get("aggregate_type") != "alert_episode"
        or not isinstance(detail.get("event_id"), str)
        or not UUID.fullmatch(detail["event_id"])
        or not isinstance(tenant, str)
        or not UUID.fullmatch(tenant)
        or not isinstance(episode, str)
        or not UUID.fullmatch(episode)
        or not isinstance(version, str)
        or not version.isdecimal()
        or int(version) < 1
        or not isinstance(payload, dict)
        or payload.get("episode_id") != episode
        or payload.get("episode_version") != version
        or not isinstance(payload.get("state"), str)
        or payload["state"] not in {"open", "acknowledged", "resolved"}
        or payload["state"] not in allowed_states[detail_type]
        or not isinstance(payload.get("severity"), str)
        or payload.get("severity") not in {"warning", "critical"}
        or type(payload.get("escalation_level")) is not int
        or not 0 <= payload["escalation_level"] <= 10
        or not isinstance(payload.get("transition_at"), str)
    ):
        raise ValueError("invalid alert lifecycle detail")
    return detail


def _table_resource():
    global _table
    if _table is None:
        _table = boto3.resource("dynamodb").Table(os.environ["ESCALATION_TABLE"])
    return _table


def apply_event(table, event: dict) -> bool:
    detail = _event_detail(event)
    payload = detail["payload"]
    item = {
        "tenant_id": detail["tenant_id"],
        "episode_id": detail["aggregate_id"],
        "episode_version": int(detail["aggregate_version"]),
        "event_id": detail["event_id"],
        "state": payload["state"],
        "severity": payload["severity"],
        "escalation_level": int(payload["escalation_level"]),
        "transition_at": payload["transition_at"],
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        table.put_item(
            Item=item,
            ConditionExpression=(
                "attribute_not_exists(episode_version) OR episode_version < :version"
            ),
            ExpressionAttributeValues={":version": item["episode_version"]},
        )
        return True
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return False
        raise


def handler(event, _context):
    return {"applied": apply_event(_table_resource(), event)}
