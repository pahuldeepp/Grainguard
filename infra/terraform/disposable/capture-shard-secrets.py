#!/usr/bin/env python3
"""Capture read-only secret inventory from the four owned physical shard identities."""
import json
import re
import sys

SHARD_IDS = frozenset({"s1", "s2", "s3", "s4"})
SHARD_ADDRESS = re.compile(r'aws_db_instance\.shard\["(s[1-4])"\]')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key in shard capture")
        result[key] = value
    return result


def validate_secret(arn, region, account):
    if not isinstance(arn, str) or not re.fullmatch(
            rf"arn:aws[a-z-]*:secretsmanager:{re.escape(region)}:{account}:secret:rds![A-Za-z0-9/_+=.@-]+", arn):
        raise ValueError("shard master secret ARN does not match saved account/region or RDS ownership")
    return arn


def capture(outputs, state, region, account):
    if not re.fullmatch(r"[a-z]{2}-[a-z]+-[0-9]+", region) or not re.fullmatch(r"[0-9]{12}", account):
        raise ValueError("invalid shard capture account/region")
    if not isinstance(outputs, dict) or not isinstance(state, dict):
        raise ValueError("shard capture requires object outputs and state")
    output_arns = []
    if "postgres_shards" in outputs:
        item = outputs["postgres_shards"]
        registry = item.get("value") if isinstance(item, dict) else None
        if not isinstance(registry, dict) or set(registry) != SHARD_IDS:
            raise ValueError("invalid shard registry output")
        for shard_id in sorted(SHARD_IDS):
            shard = registry[shard_id]
            if not isinstance(shard, dict):
                raise ValueError("invalid shard registry entry")
            output_arns.append(validate_secret(shard.get("master_secret_arn"), region, account))
        if len(set(output_arns)) != len(output_arns):
            raise ValueError("duplicate secret ARN across physical output shards")
    values = state.get("values", {})
    if not isinstance(values, dict) or not isinstance(values.get("root_module", {}), dict):
        raise ValueError("invalid shard state values")
    root = values.get("root_module", {})
    resources = root.get("resources", [])
    if not isinstance(resources, list):
        raise ValueError("invalid shard state resources")
    state_arns, state_shards = [], set()
    for resource in resources:
        if not isinstance(resource, dict):
            raise ValueError("invalid shard state resource")
        address = resource.get("address", "")
        # A candidate with inconsistent type/name/address must not disappear
        # from inventory merely because one identifying field was malformed.
        candidate = (resource.get("type") == "aws_db_instance" and resource.get("name") == "shard" or
                     isinstance(address, str) and address.startswith("aws_db_instance.shard"))
        if not candidate:
            continue
        match = SHARD_ADDRESS.fullmatch(address) if isinstance(address, str) else None
        if (not match or resource.get("mode") != "managed" or resource.get("type") != "aws_db_instance"
                or resource.get("name") != "shard"):
            raise ValueError("invalid physical shard resource identity")
        shard_id = match[1]
        if "index" in resource and resource["index"] != shard_id:
            raise ValueError("physical shard index differs from resource address")
        if shard_id in state_shards:
            raise ValueError("duplicate physical shard resource identity")
        state_shards.add(shard_id)
        data = resource.get("values", {})
        secrets = data.get("master_user_secret") if isinstance(data, dict) else None
        if not isinstance(secrets, list) or len(secrets) != 1 or not isinstance(secrets[0], dict):
            raise ValueError("shard master secret unavailable in partial state")
        state_arns.append(validate_secret(secrets[0].get("secret_arn"), region, account))
    if len(set(state_arns)) != len(state_arns):
        raise ValueError("duplicate secret ARN across physical state shards")
    # Each source separately has at most s1..s4, but stale outputs/current
    # state can legitimately name different secrets for the same shard.
    # The final read-only inventory retains both generations, deduplicated.
    return list(dict.fromkeys(output_arns + state_arns))


def main():
    if len(sys.argv) != 3:
        raise ValueError("usage: capture-shard-secrets.py <region> <account>")
    stream = sys.stdin.read()
    outputs, offset = json.JSONDecoder(object_pairs_hook=unique_object).raw_decode(stream)
    state = json.loads(stream[offset:].strip() or "{}", object_pairs_hook=unique_object)
    print("\n".join(capture(outputs, state, *sys.argv[1:])))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, TypeError, KeyError) as error:
        print(f"destroy-verified: {error}", file=sys.stderr)
        raise SystemExit(1)
