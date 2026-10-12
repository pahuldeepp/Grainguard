#!/usr/bin/env python3
"""Own one disposable Stripe test webhook; never print credentials or responses."""
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

EVENTS = ["checkout.session.completed", "customer.subscription.created",
          "customer.subscription.updated", "customer.subscription.deleted",
          "customer.subscription.paused", "customer.subscription.resumed",
          "invoice.created", "invoice.updated", "invoice.paid",
          "invoice.payment_failed", "invoice.finalized", "invoice.voided"]


def aws(*args, payload=None):
    result = subprocess.run(["aws", *args, "--output", "json"], input=payload,
                            capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(f"AWS {args[0]} {args[1]} failed; values withheld")
    return json.loads(result.stdout)


def stripe(key, method, path, fields=None, idempotency=None):
    if not re.fullmatch(r"(?:sk|rk)_test_[A-Za-z0-9]+", key):
        raise ValueError("Only Stripe test credentials are permitted")
    headers = {"Authorization": "Basic " + base64.b64encode((key + ":").encode()).decode()}
    if idempotency:
        headers["Idempotency-Key"] = idempotency
    data = None if fields is None else urllib.parse.urlencode(fields, doseq=True).encode()
    request = urllib.request.Request("https://api.stripe.com/v1/" + path,
                                     data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Stripe request failed (HTTP {error.code}); values withheld") from None
    except (urllib.error.URLError, TimeoutError):
        raise RuntimeError("Stripe request failed; values withheld") from None


def validate_scope(scope):
    if set(scope) != {"account_id", "region", "environment", "cluster", "secret_arn", "seed_version", "url"}:
        raise ValueError("Invalid webhook scope keys")
    if not re.fullmatch(r"[0-9]{12}", scope["account_id"]) or scope["environment"] != "disposable":
        raise ValueError("Only an account-bound disposable cell is permitted")
    if not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-[0-9]+", scope["region"]) or not re.fullmatch(r"[a-z][a-z0-9-]{0,99}", scope["cluster"]):
        raise ValueError("Invalid region or cluster")
    prefix = f"arn:aws:secretsmanager:{scope['region']}:{scope['account_id']}:secret:greenguard/disposable/billing-service-config-"
    if not scope["secret_arn"].startswith(prefix) or not re.fullmatch(r"[A-Za-z0-9-]{32,64}", scope["seed_version"]):
        raise ValueError("Billing secret/version is outside the cell")
    url = urllib.parse.urlsplit(scope["url"])
    if url.scheme != "https" or not re.fullmatch(r"d[a-z0-9]+\.cloudfront\.net", url.netloc) or url.path != "/webhooks/stripe" or url.query or url.fragment:
        raise ValueError("Webhook must target the exact cell CloudFront HTTPS path")
    return scope


def owner(scope):
    return {"greenguard_cell": hashlib.sha256(scope["secret_arn"].encode()).hexdigest(),
            "aws_account": scope["account_id"], "environment": scope["environment"],
            "cluster": scope["cluster"]}


def source(scope, version=None):
    args = ["secretsmanager", "get-secret-value", "--region", scope["region"],
            "--secret-id", scope["secret_arn"]]
    args += ["--version-id", version] if version else ["--version-stage", "AWSCURRENT"]
    response = aws(*args)
    if response.get("ARN") != scope["secret_arn"] or (version and response.get("VersionId") != version):
        raise RuntimeError("Billing secret identity mismatch")
    return json.loads(response["SecretString"])


def guard(scope):
    if aws("sts", "get-caller-identity")["Account"] != scope["account_id"]:
        raise RuntimeError("AWS account differs from webhook scope")
    record = aws("secretsmanager", "describe-secret", "--region", scope["region"], "--secret-id", scope["secret_arn"])
    tags = {entry["Key"]: entry["Value"] for entry in record.get("Tags", [])}
    if record.get("ARN") != scope["secret_arn"] or record.get("DeletedDate") or tags.get("Cell") != scope["cluster"] or tags.get("RuntimeSecretOwner") != "greenguard-disposable-secret-sync":
        raise RuntimeError("Billing secret ownership mismatch")


def endpoints(key, scope):
    found = []
    cursor = None
    while True:
        query = {"limit": 100}
        if cursor:
            query["starting_after"] = cursor
        page = stripe(key, "GET", "webhook_endpoints?" + urllib.parse.urlencode(query))
        for entry in page["data"]:
            if entry.get("metadata", {}).get("greenguard_cell") == owner(scope)["greenguard_cell"]:
                if entry.get("livemode") is not False or entry.get("metadata") != owner(scope) or not re.fullmatch(r"we_[A-Za-z0-9]+", entry.get("id", "")):
                    raise RuntimeError("Stripe endpoint ownership mismatch")
                found.append(entry)
        if not page.get("has_more"):
            return found
        if not page["data"]:
            raise RuntimeError("Invalid Stripe pagination")
        cursor = page["data"][-1]["id"]


def retained_signer(scope, endpoint_id):
    versions = aws("secretsmanager", "list-secret-version-ids", "--region", scope["region"],
                   "--secret-id", scope["secret_arn"], "--include-deprecated")
    for version in versions.get("Versions", []):
        data = source(scope, version["VersionId"])
        raw = data.get("STRIPE_WEBHOOK_SECRETS", "")
        signers = [value.strip() for value in raw.split(",")] if isinstance(raw, str) else []
        if (data.get("GREENGUARD_STRIPE_WEBHOOK_ENDPOINT_ID") == endpoint_id
                and 1 <= len(signers) <= 2
                and all(re.fullmatch(r"whsec_[A-Za-z0-9]+", value) for value in signers)):
            return ",".join(signers)
    return None


def apply(scope):
    seed = source(scope, scope["seed_version"])
    key = seed["STRIPE_API_KEY"]
    found = endpoints(key, scope)
    if len(found) > 1:
        raise RuntimeError("Multiple owned Stripe endpoints require review")
    endpoint = found[0] if found else None
    signing_secret = retained_signer(scope, endpoint["id"]) if endpoint else None
    fields = {"url": scope["url"], "enabled_events[]": EVENTS,
              **{f"metadata[{k}]": v for k, v in owner(scope).items()}}
    if not signing_secret:
        # A failed create may have reached Stripe before its response was stored.
        # Replaying this exact idempotent call recovers its one-time secret.
        token = hashlib.sha256((scope["secret_arn"] + scope["seed_version"] + scope["url"]).encode()).hexdigest()
        created = stripe(key, "POST", "webhook_endpoints", fields, token)
        if endpoint and endpoint["id"] != created.get("id"):
            # Never silently replace a signer lost beyond Stripe's replay window.
            if (created.get("livemode") is False and created.get("metadata") == owner(scope)
                    and not (found and created.get("id") == found[0].get("id"))
                    and re.fullmatch(r"we_[A-Za-z0-9]+", created.get("id", ""))):
                stripe(key, "DELETE", "webhook_endpoints/" + created["id"])
            raise RuntimeError("Existing webhook signing secret unavailable; recovery required")
        endpoint = created
        signing_secret = created.get("secret", "")
        if endpoint.get("livemode") is not False or endpoint.get("metadata") != owner(scope) or not re.fullmatch(r"we_[A-Za-z0-9]+", endpoint.get("id", "")) or endpoint.get("url") != scope["url"] or endpoint.get("status") != "enabled" or set(endpoint.get("enabled_events", [])) != set(EVENTS) or not re.fullmatch(r"whsec_[A-Za-z0-9]+", signing_secret):
            # Only remove a response that proves ownership by this disposable
            # cell. Never clean up a foreign or live endpoint on malformed data.
            if (created.get("livemode") is False and created.get("metadata") == owner(scope)
                    and not (found and created.get("id") == found[0].get("id"))
                    and re.fullmatch(r"we_[A-Za-z0-9]+", created.get("id", ""))):
                stripe(key, "DELETE", "webhook_endpoints/" + created["id"])
            raise RuntimeError("Stripe returned an invalid test endpoint")
    else:
        updated = stripe(key, "POST", "webhook_endpoints/" + endpoint["id"], {**fields, "disabled": "false"})
        if updated.get("url") != scope["url"] or updated.get("status") != "enabled":
            raise RuntimeError("Stripe webhook URL update did not succeed")
    payload = {**seed, "STRIPE_WEBHOOK_SECRETS": signing_secret,
               "GREENGUARD_STRIPE_WEBHOOK_ENDPOINT_ID": endpoint["id"]}
    token = hashlib.sha256((scope["seed_version"] + scope["url"] + endpoint["id"]).encode()).hexdigest()
    aws("secretsmanager", "put-secret-value", "--region", scope["region"],
        "--secret-id", scope["secret_arn"], "--client-request-token", token,
        "--secret-string", "file:///dev/stdin", payload=json.dumps(payload))
    if source(scope) != payload:
        raise RuntimeError("Stripe billing secret readback failed")
    print("PASS cell-owned Stripe test webhook and signing secret configured; values withheld")


def destroy(scope):
    # Rotation can already have written a new account's seed as AWSCURRENT.
    # The old ownership record must remove endpoints using its pinned API key.
    data = source(scope, scope["seed_version"])
    key = data["STRIPE_API_KEY"]
    found = endpoints(key, scope)
    for endpoint in found:
        if endpoint.get("url") != scope["url"]:
            raise RuntimeError("Owned webhook URL changed; refusing deletion")
    for endpoint in found:
        result = stripe(key, "DELETE", "webhook_endpoints/" + endpoint["id"])
        if not result.get("deleted"):
            raise RuntimeError("Stripe webhook deletion failed")
    if endpoints(key, scope):
        raise RuntimeError("Stripe webhook remains after teardown")
    print("PASS cell-owned Stripe test webhook removed")


def main():
    if sys.argv[1:] not in (["apply"], ["destroy"]):
        raise ValueError("Expected apply or destroy")
    scope = validate_scope(json.loads(os.environ["GG_STRIPE_WEBHOOK_SCOPE"]))
    guard(scope)
    (apply if sys.argv[1] == "apply" else destroy)(scope)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # SDK/HTTP failures may embed secret request/response material.
        print(f"FAIL Stripe webhook lifecycle ({type(error).__name__}); details withheld", file=sys.stderr)
        sys.exit(1)
