"""Create the dedicated test bucket after MinIO becomes reachable."""

import os
import time

import boto3
from botocore.config import Config


client = boto3.client(
    "s3",
    region_name="us-east-1",
    endpoint_url="http://minio:9000",
    aws_access_key_id=os.environ["MINIO_USER"],
    aws_secret_access_key=os.environ["MINIO_PASSWORD"],
    config=Config(s3={"addressing_style": "path"}, connect_timeout=2, read_timeout=2, retries={"max_attempts": 1}),
)
bucket = os.environ["TELEMETRY_ARCHIVE_BUCKET"]
deadline = time.monotonic() + 90
while True:
    try:
        client.head_bucket(Bucket=bucket)
        break
    except Exception:
        try:
            client.create_bucket(Bucket=bucket)
            break
        except Exception:
            if time.monotonic() >= deadline:
                raise RuntimeError("local MinIO did not initialize the telemetry bucket") from None
            time.sleep(1)
print("Local telemetry bucket is ready.")
