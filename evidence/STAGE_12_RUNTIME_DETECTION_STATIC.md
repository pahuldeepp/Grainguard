# Stage 12.11 — runtime detection static record

Date: 2026-09-26

Falco was selected. Added two scoped runtime rules for noninteractive shell execution and
connection attempts to the AWS metadata address from `greenguard` containers.
Output carries workload and process/network identity without command-line
arguments. Added a Helm values profile pinning the chart, rules artifact and
metadata plugins, enabling JSON and Falcosidekick Alertmanager output, plus a
CLI validation entry point and collector/alerting instructions.

Falco chart artifact refs are set under `falcoctl.config.artifact.install.refs`,
automatic artifact following is disabled, `rule_matching: all` is enabled, and
the raw configuration overlay preserves the standard local rules file and
`rules.d` load paths.

The Falco CLI is not installed, so rule-engine validation did not run. No
Falco DaemonSet, kernel driver, controlled runtime event, or alert delivery was
tested. A YAML parse checks only file syntax. Stage 12.11 remains in progress.
