MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="GREENGUARD-PARSER"

--GREENGUARD-PARSER
Content-Type: text/x-shellscript; charset="us-ascii"

#!/bin/bash
set -euo pipefail
# Pin the complete release, including gvisor-bin sidecars; no latest URL.
test "$(uname -m)" = x86_64
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl --fail --silent --show-error --location --retry 3 --max-time 180 \
 https://github.com/google/gvisor/releases/download/release-20260928.0/gvisor-x86_64.tar.bz2 -o "$work/gvisor.tar.bz2"
printf '%s  %s\n' 'c8d3a9fd4d4c4f5b8ff213caa4517356be128d18659ec4cde37828fe797f61a9725a602a846c81a8ed19c057a996515d31c081eba343ed4613a89951ba32ed59' "$work/gvisor.tar.bz2" | sha512sum --check -
tar -xjf "$work/gvisor.tar.bz2" -C /usr/local/bin
chmod 0755 /usr/local/bin/runsc /usr/local/bin/containerd-shim-runsc-v1
/usr/local/bin/runsc --version
# nodeadm merges this runtime handler with the EKS-managed cluster config.
mkdir -p /etc/eks/nodeadm.d /etc/containerd
cat > /etc/containerd/runsc.toml <<'RUNSC'
[runsc_config]
  systemd-cgroup = "true"
RUNSC
cat > /etc/eks/nodeadm.d/50-greenguard-parser.yaml <<'CONFIG'
apiVersion: node.eks.aws/v1alpha1
kind: NodeConfig
spec:
  containerd:
    config: |
      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]
        runtime_type = "io.containerd.runsc.v1"
      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc.options]
        TypeUrl = "io.containerd.runsc.v1.options"
        ConfigPath = "/etc/containerd/runsc.toml"
CONFIG

--GREENGUARD-PARSER--
