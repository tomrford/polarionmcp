#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
deno run -A npm:openapi-typescript@7.10.1 polarionrest.json -o generated/polarion.ts
