"""Local lab entry point; production S3 clients continue using AWS Pod Identity."""

import os
import threading

import boto3
from botocore.config import Config

from telemetry_sinks.runtime import install_signal_handlers, run


endpoint = os.environ["S3_ENDPOINT_URL"]
if endpoint != "http://minio:9000":
    raise RuntimeError("local telemetry lab only accepts its private Compose MinIO endpoint")
client = boto3.client(
    "s3",
    region_name=os.environ["AWS_REGION"],
    endpoint_url=endpoint,
    aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
    config=Config(s3={"addressing_style": "path"}, connect_timeout=5, read_timeout=20),
)
stop = threading.Event()
install_signal_handlers(stop)
run("s3-archive", s3_client=client, stop_event=stop)
