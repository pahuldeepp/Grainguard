#!/usr/bin/env python3
import aws_cdk as cdk

from greenguard_serverless_stack import GreenGuardServerlessStack

app = cdk.App(outdir="cdk.out")
environment = app.node.try_get_context("environment") or "dev"
GreenGuardServerlessStack(
    app,
    f"GreenGuardServerless-{environment}",
    environment_name=environment,
    env=cdk.Environment(account=app.account, region=app.region),
)
app.synth()
