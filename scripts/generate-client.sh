#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
deno run -A npm:openapi-typescript@7.10.1 \
  packages/polarion-tools/polarionrest.json \
  -o packages/polarion-tools/generated/polarion.ts
