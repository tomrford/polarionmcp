#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bunx openapi-typescript polarionrest.json -o generated/polarion.ts
