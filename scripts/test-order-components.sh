#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."

project="lab3-order-test-$(date +%s)-$$"
run_compose() {
  docker compose -f compose.order-test.yaml -p "$project" "$@"
}
cleanup() {
  run_compose down --remove-orphans --rmi local
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_compose up -d --wait --wait-timeout 90 db
run_compose run --build --rm component
