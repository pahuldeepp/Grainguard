mock_provider "aws" {
  mock_resource "aws_secretsmanager_secret" {
    defaults = {
      arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:greenguard-fixture"
      id  = "greenguard-fixture"
    }
  }

  mock_resource "aws_secretsmanager_secret_version" {
    defaults = {
      arn                  = "arn:aws:secretsmanager:us-east-1:123456789012:secret:greenguard-fixture"
      version_id           = "fixture-version"
      version_stages       = ["AWSCURRENT"]
      has_secret_string_wo = true
      secret_string        = null
    }
  }
}

run "write_only_secret_payload" {
  command = apply

  variables {
    secret_name     = "greenguard-no-state-fixture"
    version_counter = 1
  }

  assert {
    condition     = aws_secretsmanager_secret_version.runtime.version_id == "fixture-version"
    error_message = "mock Secrets Manager version should be created"
  }

  assert {
    condition     = aws_secretsmanager_secret_version.runtime.has_secret_string_wo && nonsensitive(aws_secretsmanager_secret_version.runtime.secret_string) == null
    error_message = "the write-only provider argument must not be represented by a persisted secret_string value"
  }
}
