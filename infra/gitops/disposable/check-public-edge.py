#!/usr/bin/env python3
"""Read-only public HTTPS edge acceptance for one disposable GreenGuard cell."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

AWS_TIMEOUT_SECONDS = 8
HTTPS_TIMEOUT_SECONDS = 10
MAX_DASHBOARD_BYTES = 1_048_576


class EdgeCheckError(ValueError):
    retryable = False


class TransientEdgeCheckError(EdgeCheckError):
    retryable = True


def aws_json(*args: str) -> dict:
    """Run AWS CLI without exposing response/error payloads in diagnostics."""
    try:
        result = subprocess.run(
            ["aws", *args, "--output", "json"],
            capture_output=True,
            text=True,
            check=False,
            timeout=AWS_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        raise TransientEdgeCheckError(f"AWS inventory command timed out ({args[0]})") from error
    except OSError as error:
        raise EdgeCheckError(f"AWS inventory command unavailable ({args[0]})") from error
    if result.returncode:
        raise EdgeCheckError(f"AWS inventory command failed ({args[0]})")
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise EdgeCheckError(f"AWS inventory returned invalid JSON ({args[0]})") from error
    if not isinstance(value, dict):
        raise EdgeCheckError(f"AWS inventory returned an invalid object ({args[0]})")
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def https_probe(url: str, timeout: int = HTTPS_TIMEOUT_SECONDS) -> tuple[int, str, bytes]:
    request = urllib.request.Request(url, headers={"User-Agent": "GreenGuard-disposable-edge-check/1"})
    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, response.headers.get("Content-Type", ""), response.read(MAX_DASHBOARD_BYTES)
    except urllib.error.HTTPError as error:
        # Do not read or expose response body/error text.
        return error.code, error.headers.get("Content-Type", ""), b""
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise TransientEdgeCheckError("public HTTPS endpoint could not be reached within the bounded timeout") from error


def _dict(value, name):
    if not isinstance(value, dict):
        raise EdgeCheckError(f"invalid {name} input")
    return value


def validate_scope(cell: dict, target_group_arn: str) -> tuple[str, str]:
    cell = _dict(cell, "cell identity")
    region, account, environment, cluster = (
        cell.get("region"), cell.get("account_id"), cell.get("environment"), cell.get("cluster_name")
    )
    if (not isinstance(region, str) or not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-[0-9]+", region)
            or not isinstance(account, str) or not re.fullmatch(r"[0-9]{12}", account)
            or not isinstance(cluster, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", cluster)
            or not isinstance(environment, str) or environment.lower() in {"prod", "production"}):
        raise EdgeCheckError("refusing invalid or production cell identity")
    expected_arn = re.compile(
        rf"^arn:aws:elasticloadbalancing:{re.escape(region)}:{account}:targetgroup/[A-Za-z0-9-]+/[a-f0-9]{{16}}$"
    )
    if not isinstance(target_group_arn, str) or not expected_arn.fullmatch(target_group_arn):
        raise EdgeCheckError("target group ARN does not belong to the selected AWS account and region")
    return region, cluster


def validate_public_url(raw: str, role: str) -> urllib.parse.SplitResult:
    try:
        parsed = urllib.parse.urlsplit(raw)
        port = parsed.port
    except (TypeError, ValueError) as error:
        raise EdgeCheckError(f"{role} URL must be an exact HTTPS CloudFront URL") from error
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or port is not None):
        raise EdgeCheckError(f"{role} URL must be an exact HTTPS CloudFront URL")
    if role == "dashboard" and parsed.path not in ("", "/"):
        raise EdgeCheckError("dashboard URL must name the CloudFront distribution root")
    if role == "api" and parsed.path != "/graphql":
        raise EdgeCheckError("API URL must be the deployed BFF /graphql endpoint")
    host = parsed.hostname.lower()
    if not re.fullmatch(r"d[0-9a-z]+\.cloudfront\.net", host):
        raise EdgeCheckError(f"{role} URL must use an AWS-owned CloudFront distribution hostname")
    return parsed


def _tags(value: dict) -> dict[str, str]:
    tags = value.get("Tags", {})
    items = tags.get("Items", tags.get("Tag", [])) if isinstance(tags, dict) else []
    if not isinstance(items, list):
        return {}
    return {item.get("Key"): item.get("Value") for item in items if isinstance(item, dict)}


def _elbv2_tags(response: dict, resource_arn: str) -> dict[str, str]:
    descriptions = response.get("TagDescriptions")
    if (not isinstance(descriptions, list) or len(descriptions) != 1
            or not isinstance(descriptions[0], dict)
            or descriptions[0].get("ResourceArn") != resource_arn
            or not isinstance(descriptions[0].get("Tags"), list)):
        raise EdgeCheckError("AWS returned missing or ambiguous load balancer resource tags")
    return {tag.get("Key"): tag.get("Value") for tag in descriptions[0]["Tags"]
            if isinstance(tag, dict)}


def _cloudfront_distribution(aws, account: str, distribution_id: str, role,
                             supplied_url: str, load_balancer_dns: str,
                             load_balancer_arn: str, cluster: str) -> None:
    if not re.fullmatch(r"[A-Z0-9]{8,32}", distribution_id or ""):
        raise EdgeCheckError(f"{role} distribution ID is invalid")
    data = aws("cloudfront", "get-distribution", "--id", distribution_id)
    distribution = _dict(data.get("Distribution"), f"{role} CloudFront distribution")
    if distribution.get("Id") != distribution_id:
        raise EdgeCheckError(f"{role} CloudFront distribution identity does not match")
    if distribution.get("Status") != "Deployed":
        raise TransientEdgeCheckError(f"{role} CloudFront distribution is not deployed")
    config = _dict(distribution.get("DistributionConfig"), f"{role} CloudFront config")
    domain = distribution.get("DomainName", "")
    parsed = validate_public_url(supplied_url, role)
    if not config.get("Enabled") or not isinstance(domain, str) or domain.lower() != parsed.hostname.lower():
        raise EdgeCheckError(f"{role} URL does not match its deployed CloudFront distribution")
    aliases = config.get("Aliases", {})
    if not isinstance(aliases, dict):
        raise EdgeCheckError(f"{role} CloudFront aliases are malformed")
    if aliases.get("Quantity", 0) != 0 or aliases.get("Items"):
        raise EdgeCheckError(f"{role} distribution is not using its AWS-owned CloudFront hostname")
    arn = f"arn:aws:cloudfront::{account}:distribution/{distribution_id}"
    tags = _tags(aws("cloudfront", "list-tags-for-resource", "--resource", arn))
    if tags.get("Cell") != cluster:
        raise EdgeCheckError(f"{role} CloudFront distribution is not tagged for this disposable cell")
    origins = _dict(config.get("Origins"), f"{role} origin list")
    items = origins.get("Items", [])
    if origins.get("Quantity") != 1 or not isinstance(items, list) or len(items) != 1:
        raise EdgeCheckError(f"{role} distribution must have exactly one cell-owned origin")
    origin = _dict(items[0], f"{role} origin")
    vpc_origin = origin.get("VpcOriginConfig")
    if not isinstance(vpc_origin, dict) or not vpc_origin.get("VpcOriginId"):
        raise EdgeCheckError(f"{role} CloudFront distribution does not use a VPC origin")
    vpc_origin_id = vpc_origin["VpcOriginId"]
    if not isinstance(vpc_origin_id, str) or not re.fullmatch(r"vo_[A-Za-z0-9]+", vpc_origin_id):
        raise EdgeCheckError(f"{role} CloudFront VPC origin ID is malformed")
    vpc_data = aws("cloudfront", "get-vpc-origin", "--id", vpc_origin_id)
    vpc_record = _dict(vpc_data.get("VpcOrigin"), f"{role} CloudFront VPC origin")
    endpoint = _dict(vpc_record.get("VpcOriginEndpointConfig"), f"{role} VPC origin endpoint")
    vpc_arn = vpc_record.get("Arn")
    endpoint_arn = endpoint.get("Arn")
    vpc_arn_prefix = f"arn:aws:cloudfront::{account}:"
    if (vpc_record.get("Id") != vpc_origin_id
            or vpc_record.get("AccountId") not in (None, account)
            or vpc_record.get("Status") != "Deployed"
            or endpoint_arn != load_balancer_arn
            or not isinstance(vpc_arn, str) or not vpc_arn.startswith(vpc_arn_prefix)
            or vpc_arn.rsplit("/", 1)[-1] != vpc_origin_id):
        raise EdgeCheckError(f"{role} CloudFront VPC origin is not the selected cell's deployed ALB origin")
    vpc_tags = _tags(aws("cloudfront", "list-tags-for-resource", "--resource", vpc_arn))
    if vpc_tags.get("Cell") != cluster:
        raise EdgeCheckError(f"{role} CloudFront VPC origin is not tagged for this disposable cell")
    custom_headers = origin.get("CustomHeaders", {})
    if not isinstance(custom_headers, dict):
        raise EdgeCheckError(f"{role} CloudFront origin headers are malformed")
    headers = custom_headers.get("Items", []) if isinstance(custom_headers, dict) else []
    if not isinstance(headers, list):
        raise EdgeCheckError(f"{role} CloudFront origin headers are malformed")
    expected_header = "dashboard" if role == "dashboard" else "bff"
    header_ok = any(isinstance(header, dict) and isinstance(header.get("HeaderName"), str)
                    and header["HeaderName"].lower() == "x-greenguard-origin"
                    and header.get("HeaderValue") == expected_header for header in headers)
    origin_domain = origin.get("DomainName")
    if not isinstance(origin_domain, str) or origin_domain.lower() != load_balancer_dns.lower() or not header_ok:
        raise EdgeCheckError(f"{role} CloudFront origin does not select this cell's ALB route")


def check_public_edge(cell: dict, target_group_arn: str, dashboard_url: str, api_url: str,
                      dashboard_distribution_id: str, api_distribution_id: str,
                      aws=aws_json, probe=https_probe) -> list[str]:
    region, cluster = validate_scope(cell, target_group_arn)
    account = cell["account_id"]
    current = aws("sts", "get-caller-identity")
    if current.get("Account") != account:
        raise EdgeCheckError("current AWS account does not match the selected disposable cell")

    response = aws("elbv2", "describe-target-groups", "--region", region,
                   "--target-group-arns", target_group_arn)
    groups = response.get("TargetGroups", [])
    if not isinstance(groups, list) or len(groups) != 1:
        raise EdgeCheckError("the selected target group was not found uniquely")
    target_group = _dict(groups[0], "target group")
    attached_lbs = target_group.get("LoadBalancerArns")
    if (target_group.get("TargetGroupArn") != target_group_arn or target_group.get("TargetType") != "ip"
            or target_group.get("Protocol") != "HTTP" or target_group.get("Port") != 8080
            or not isinstance(attached_lbs, list) or len(attached_lbs) != 1
            or not isinstance(attached_lbs[0], str)):
        raise EdgeCheckError("target group does not match the disposable Istio ingress target profile")
    tag_response = aws("elbv2", "describe-tags", "--region", region,
                       "--resource-arns", target_group_arn)
    tg_tags = _elbv2_tags(tag_response, target_group_arn)
    if tg_tags.get("Cell") != cluster:
        raise EdgeCheckError("target group is not tagged for the selected disposable cell")

    lb_arn = attached_lbs[0]
    lb_data = aws("elbv2", "describe-load-balancers", "--region", region,
                  "--load-balancer-arns", lb_arn)
    lbs = lb_data.get("LoadBalancers", [])
    if not isinstance(lbs, list) or len(lbs) != 1:
        raise EdgeCheckError("target group's load balancer was not found uniquely")
    lb = _dict(lbs[0], "load balancer")
    expected_name = f"{cluster}-edge"
    expected_lb_arn = re.compile(
        rf"^arn:aws:elasticloadbalancing:{re.escape(region)}:{account}:loadbalancer/app/[A-Za-z0-9-]+/[a-f0-9]+$"
    )
    if (not expected_lb_arn.fullmatch(lb_arn) or lb.get("LoadBalancerArn") != lb_arn
            or lb.get("Scheme") != "internal" or lb.get("Type") != "application"):
        raise EdgeCheckError("target group is not attached to the selected internal application load balancer")
    lb_tags_data = aws("elbv2", "describe-tags", "--region", region, "--resource-arns", lb_arn)
    lb_tags = _elbv2_tags(lb_tags_data, lb_arn)
    if lb_tags.get("Name") != expected_name:
        raise EdgeCheckError("load balancer is not owned by the selected disposable cell")

    health_data = aws("elbv2", "describe-target-health", "--region", region,
                      "--target-group-arn", target_group_arn)
    target_health = health_data.get("TargetHealthDescriptions", [])
    if not isinstance(target_health, list) or not target_health:
        raise TransientEdgeCheckError("target group has no registered ingress targets")
    unhealthy = [item for item in target_health if not isinstance(item, dict)
                 or not isinstance(item.get("TargetHealth"), dict)
                 or item["TargetHealth"].get("State") != "healthy"]
    if unhealthy:
        states = sorted({
            state if isinstance(state, str) and re.fullmatch(r"[a-z-]{1,32}", state) else "unknown"
            for item in unhealthy
            for state in [item.get("TargetHealth", {}).get("State")
                          if isinstance(item, dict) and isinstance(item.get("TargetHealth"), dict) else None]
        })
        raise TransientEdgeCheckError("target group contains non-healthy ingress targets: " + ", ".join(states))

    lb_dns = lb.get("DNSName")
    if not isinstance(lb_dns, str) or not lb_dns:
        raise EdgeCheckError("cell load balancer has no DNS name")
    _cloudfront_distribution(aws, account, dashboard_distribution_id, "dashboard", dashboard_url,
                             lb_dns, lb_arn, cluster)
    _cloudfront_distribution(aws, account, api_distribution_id, "api", api_url,
                             lb_dns, lb_arn, cluster)

    dashboard_status, content_type, body = probe(dashboard_url.rstrip("/") + "/")
    if dashboard_status >= 500:
        raise TransientEdgeCheckError(f"dashboard HTTPS root returned HTTP {dashboard_status}")
    if dashboard_status != 200 or not content_type.lower().startswith("text/html") or b"greenguard" not in body.lower():
        raise EdgeCheckError("dashboard HTTPS root did not return GreenGuard HTML")
    api_origin = api_url.removesuffix("/graphql")
    for path in ("/healthz", "/readyz"):
        status, _, _ = probe(api_origin + path)
        if status != 204:
            if status >= 500:
                raise TransientEdgeCheckError(f"BFF public {path} health check returned HTTP {status}")
            raise EdgeCheckError(f"BFF public {path} health check returned HTTP {status}, expected 204")
    return ["healthy ingress targets", "cell-owned CloudFront distributions and origins", "dashboard HTML", "BFF /healthz", "BFF /readyz"]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cell-file", required=True, help="saved disposable_cell_identity Terraform output JSON")
    parser.add_argument("--target-group-arn", required=True)
    parser.add_argument("--dashboard-url", required=True)
    parser.add_argument("--api-url", required=True, help="exact edge_urls.bff including /graphql")
    parser.add_argument("--dashboard-distribution-id", required=True)
    parser.add_argument("--api-distribution-id", required=True)
    args = parser.parse_args(argv)
    try:
        cell = json.loads(Path(args.cell_file).read_text())
        check_public_edge(cell, args.target_group_arn, args.dashboard_url, args.api_url,
                          args.dashboard_distribution_id, args.api_distribution_id)
    except (OSError, json.JSONDecodeError, EdgeCheckError) as error:
        print(f"BLOCKED: {error}", file=sys.stderr)
        return 2 if getattr(error, "retryable", False) else 1
    print("PASS: cell-owned public HTTPS dashboard and BFF edge routes are healthy.")
    print("Scope: AWS edge routing and health only; authenticated tenant workflows are not covered.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
