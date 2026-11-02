#!/bin/sh
# Restarts the JobManager from the newest retained checkpoint after a JobManager loss (Compose only; on
# Kubernetes the operator's HA and upgradeMode last-state do this). Usage: infra/flink/restore.sh "<compose prefix>"
set -eu
COMPOSE=${1:?compose command prefix required}
CHK=$($COMPOSE run -T --rm --no-deps --entrypoint sh flink-jobmanager -c \
  'ls -dt /checkpoints/*/chk-* 2>/dev/null | head -1')
[ -n "$CHK" ] || { echo "no retained checkpoint under /checkpoints; the job will start from committed offsets with empty state" >&2; exit 1; }
echo "restoring from $CHK"
FLINK_RESTORE_ARGS="--fromSavepoint $CHK" $COMPOSE up -d --force-recreate --no-deps flink-jobmanager
