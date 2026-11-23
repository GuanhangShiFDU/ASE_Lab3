#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
for service in order order-query driver dispatch; do
  docker compose exec -T "$service" node -e '
    const expected = process.argv[1];
    const response = await fetch("http://127.0.0.1:3000/health");
    const body = await response.json();
    if (!response.ok || body.status !== "ok" || body.service !== expected) {
      throw new Error("Unexpected health response for " + expected);
    }
    console.log("OK " + expected);
  ' "$service"
done
