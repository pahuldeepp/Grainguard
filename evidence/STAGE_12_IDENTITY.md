# Stage 12.5 — workload identity implementation record

Date: 2026-09-26

## Implemented

- The EKS platform root installs the EKS Pod Identity Agent add-on.
- The EventBridge bridge role and EKS Pod Identity association are opt-in.
  Terraform requires both the existing alert bus ARN and quarantine queue ARN;
  a resource precondition rejects a partial pair.
- The association is bound to namespace `greenguard` and service account
  `eventbridge-bridge`, matching the Helm release/profile name.
- The role trust principal is `pods.eks.amazonaws.com`, restricted to this
  cluster ARN. Its only permissions are `events:PutEvents` on the configured
  EventBridge bus and `sqs:SendMessage` on the configured quarantine queue.
- The bridge uses the AWS SDK credential chain; no static AWS credentials are
  added to chart defaults or container images.

## Local evidence

- Terraform 1.16.4 `fmt -check` and platform `validate` passed.
- A synthetic plan with fake local credentials and provider API checks disabled
  showed the exact service-account association and exact two action/resource
  pairs in the inline policy. No AWS API call or apply was performed.
- A synthetic plan with both ARNs empty contained no bridge role, association,
  or trust policy. A plan with only one ARN failed the EKS resource precondition.
- `make helm-validate` asserts that the worker profile renders service account
  `eventbridge-bridge`.

## Acceptance still open

No authenticated AWS plan or EKS association has run. Runtime denial tests have
not shown that another service account cannot assume the role or that the bridge
is denied access to other buses/queues. Secrets Manager/External Secrets
installation, secret rotation, and a no-plaintext-secret scan are not complete.
This is implementation evidence only; Stage 12.5 remains in progress.
