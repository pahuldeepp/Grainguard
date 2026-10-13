#!/bin/sh
set -eu
secret_dir="${GREENGUARD_SECRET_DIR:-$HOME/.config/greenguard/secrets}"
export MODEL_GATEWAY_CONTROLS_FILE="$secret_dir/gateway-controls.json"
export MODEL_GATEWAY_REDIS_URL_FILE="$secret_dir/gateway-redis-url"
export MODEL_GATEWAY_BUDGET_DSN_FILE="$secret_dir/gateway-budget-dsn"
export MODEL_GATEWAY_ACCESS_FILE="$secret_dir/gateway-access.json"
export MODEL_GATEWAY_VOYAGE_URL=https://api.voyageai.com/v1
export MODEL_GATEWAY_VOYAGE_KEY_FILE="$secret_dir/voyage-api-key"
export MODEL_GATEWAY_ANTHROPIC_URL=https://api.anthropic.com/v1
export MODEL_GATEWAY_ANTHROPIC_KEY_FILE="$secret_dir/anthropic-api-key"
export MODEL_GATEWAY_LISTEN_ADDR=127.0.0.1:18089
cd "$(dirname "$0")"
exec go run ./cmd/model-gateway
